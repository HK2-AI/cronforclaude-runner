import { config } from "./config.js";
import { api } from "./api.js";
import { execClaude, type ExecHandle, type ExecResult } from "./exec.js";

type InFlight = {
  jobId: string;
  handle: ExecHandle;
  done: Promise<void>;
};

const inFlight = new Map<string, InFlight>();
let stopping = false;
let shutdownGraceMs = 60_000; // overridden once we know server settings

import { captureException, logger } from "./telemetry.js";

function log(...a: unknown[]) {
  // pino expects (obj, msg) or (msg) — accept a freeform variadic from existing
  // call sites and stringify the rest.
  const [first, ...rest] = a;
  if (rest.length === 0) {
    logger.info(typeof first === "string" ? first : JSON.stringify(first));
  } else {
    const msg = rest.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    logger.info(`${first} ${msg}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function runningJobIds(): string[] {
  return Array.from(inFlight.keys());
}

async function heartbeat() {
  try {
    const res = await api.heartbeat({
      status: stopping ? "draining" : "online",
      runningJobIds: runningJobIds(),
      capacity: config.maxConcurrent,
    });
    // Server reported these jobs as cancelled — kick the corresponding execs
    // ASAP so they don't have to wait for the next /log flush.
    for (const id of res.cancelled) {
      const inf = inFlight.get(id);
      if (inf) inf.handle.cancel(2000);
    }
  } catch (e) {
    log("heartbeat error:", (e as Error).message);
    captureException(e, { op: "heartbeat" });
  }
}

async function tryClaim(): Promise<boolean> {
  if (stopping) return false;
  if (inFlight.size >= config.maxConcurrent) return false;
  let claim;
  try {
    claim = await api.poll();
  } catch (e) {
    log("poll error:", (e as Error).message);
    captureException(e, { op: "poll" });
    return false;
  }
  if (!claim.job) return false;

  const job = claim.job;
  log(`claimed job ${job.id} (${job.prompt.slice(0, 60).replace(/\n/g, " ")}...)`);

  const handle = execClaude({
    prompt: job.prompt,
    workingDir: job.workingDir,
    claudeArgs: job.claudeArgs,
    timeoutSec: job.timeoutSec,
    dangerouslySkipPermissions: job.dangerouslySkipPermissions,
    effort: job.effort,
    flush: async ({ stdout, stderr, events, startIdx }) => {
      try {
        const r = await api.jobLog(job.id, { stdout, stderr, events, startIdx });
        return { cancelled: r.cancelled };
      } catch {
        return { cancelled: false };
      }
    },
  });

  const done = (async () => {
    let result: ExecResult;
    try {
      await api.jobLog(job.id, { status: "running" }).catch(() => {});
      result = await handle.promise;
      await api.jobResult(job.id, {
        status: result.status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        events: result.events.length > 0 ? result.events : undefined,
        startIdx: result.events.length > 0 ? result.eventsStartIdx : undefined,
        durationMs: result.durationMs,
        error: result.error ?? null,
      });
      log(`job ${job.id} -> ${result.status} (${result.durationMs}ms)`);
    } catch (e) {
      log(`job ${job.id} error:`, (e as Error).message);
      await api
        .jobResult(job.id, {
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: "",
          error: (e as Error).message,
        })
        .catch(() => {});
    } finally {
      inFlight.delete(job.id);
    }
  })();

  inFlight.set(job.id, { jobId: job.id, handle, done });
  return true;
}

async function pollLoop() {
  while (!stopping) {
    const claimed = await tryClaim();
    await interruptibleSleep(claimed ? 100 : config.pollIntervalMs);
  }
}

async function heartbeatLoop() {
  while (!stopping) {
    await heartbeat();
    await interruptibleSleep(config.heartbeatIntervalMs);
  }
}

/** A sleep that wakes early when `stopping` flips to true. Crucial for fast
 *  graceful shutdown — without this, a 15s heartbeat sleep would block the
 *  shutdown for up to 15s after SIGTERM. */
async function interruptibleSleep(ms: number) {
  const start = Date.now();
  while (!stopping && Date.now() - start < ms) {
    await sleep(Math.min(200, ms - (Date.now() - start)));
  }
}

async function gracefulShutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received; ${inFlight.size} job(s) in-flight, draining (grace=${Math.round(shutdownGraceMs / 1000)}s)...`);

  // Final draining heartbeat so the server stops handing us new jobs and
  // marks the runner status accordingly.
  await heartbeat();

  if (inFlight.size === 0) {
    log("no in-flight jobs; bye");
    return;
  }

  // Strategy: ask each exec to cancel; they will SIGTERM claude, wait briefly,
  // then SIGKILL. The exec's `done` promise resolves once jobResult is POSTed.
  // We bound the wait to shutdownGraceMs total. Anything still alive at that
  // point gets a hard SIGKILL and the server-side reaper will handle whatever
  // jobResult never makes it home.
  const deadline = Date.now() + shutdownGraceMs;
  for (const inf of inFlight.values()) {
    const remaining = deadline - Date.now();
    inf.handle.cancel(Math.max(1000, Math.min(remaining, 5000)));
  }

  // Wait for all in-flight to settle (or until deadline).
  await Promise.race([
    Promise.all(Array.from(inFlight.values()).map((i) => i.done)),
    (async () => {
      while (Date.now() < deadline && inFlight.size > 0) await sleep(500);
    })(),
  ]);

  if (inFlight.size > 0) {
    log(`grace period exceeded; ${inFlight.size} job(s) still in-flight, the server-side reaper will fail them after lease expires`);
  } else {
    log("all in-flight jobs settled cleanly");
  }
  // One last heartbeat as draining (so server sees no in-flight from us).
  await heartbeat().catch(() => {});
  log("bye");
}

export async function runLoop(): Promise<void> {
  log(`runner starting: name=${config.name} url=${config.schedulerUrl} maxConcurrent=${config.maxConcurrent}`);
  // Allow env override; otherwise keep server-driven via Settings.shutdownGraceSec
  // (we'd need a dedicated /api/settings endpoint exposed to runners; for now
  // honour the env). Default already 60s.
  if (process.env.SHUTDOWN_GRACE_SEC) {
    shutdownGraceMs = Math.max(5_000, Number(process.env.SHUTDOWN_GRACE_SEC) * 1000);
  }
  process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

  await heartbeat();
  await Promise.all([pollLoop(), heartbeatLoop()]);
  // Make sure all in-flight settled (gracefulShutdown awaited them, but if we
  // exit through normal loop end for any reason, still wait).
  while (inFlight.size > 0) await sleep(500);
}
