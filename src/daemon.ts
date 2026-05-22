import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PROFILE,
  envPathForProfile,
  listProfiles,
  statePath,
} from "./profile.js";

// Matches the runner loop process in `ps` output across all install shapes:
//   dev (tsx):       …/apps/runner/src/index.ts
//   dev (built):     …/apps/runner/dist/index.js
//   npm global:      …/cronforclaude-runner/dist/index.js
const RUNNER_PATTERN = /(cronforclaude-runner|apps\/runner)\/(dist|src)\/(index|run)/;

type Instance = {
  profile: string;
  pgid: string;
  pids: Array<{ pid: string; ppid: string; etime: string; cmd: string }>;
};

function listProcesses(): Array<{ pid: string; ppid: string; pgid: string; etime: string; cmd: string }> {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,etime=,command="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trimStart())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const [pid, ppid, pgid, etime, ...rest] = parts;
      return { pid: pid!, ppid: ppid!, pgid: pgid!, etime: etime!, cmd: rest.join(" ") };
    });
}

/** Parse the profile name out of the runner's argv. We spawn with a synthetic
 *  --profile=<name> flag so we can recover it from `ps` later. */
function profileFromCmd(cmd: string): string {
  const m = /--profile[= ](\S+)/.exec(cmd);
  return m ? m[1]! : DEFAULT_PROFILE;
}

function findInstances(filterProfile?: string): Instance[] {
  const procs = listProcesses();
  // Match the runner loop process, excluding any CLI invocation that has the
  // "daemon" subcommand (so `status` doesn't detect itself).
  const matching = procs.filter(
    (p) => RUNNER_PATTERN.test(p.cmd) && !/\bdaemon\b/.test(p.cmd),
  );
  const byPgid = new Map<string, Instance>();
  for (const seed of matching) {
    if (!byPgid.has(seed.pgid)) {
      byPgid.set(seed.pgid, {
        profile: profileFromCmd(seed.cmd),
        pgid: seed.pgid,
        pids: [],
      });
    }
  }
  // For each pgid, gather every process in that group (catches pnpm wrapper too).
  for (const inst of byPgid.values()) {
    inst.pids = procs
      .filter((p) => p.pgid === inst.pgid)
      .map(({ pid, ppid, etime, cmd }) => ({ pid, ppid, etime, cmd }))
      .sort((a, b) => Number(a.pid) - Number(b.pid));
  }
  let out = Array.from(byPgid.values()).sort((a, b) => Number(a.pgid) - Number(b.pgid));
  if (filterProfile) out = out.filter((i) => i.profile === filterProfile);
  return out;
}

function readTrackedPid(profile: string): string | null {
  const f = statePath(profile, "pid");
  if (!existsSync(f)) return null;
  const v = readFileSync(f, "utf8").trim();
  return v || null;
}

function pidPgid(pid: string): string | null {
  const r = spawnSync("ps", ["-p", pid, "-o", "pgid="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

function killGroup(pgid: string, signal: NodeJS.Signals | number) {
  try { process.kill(-Number(pgid), signal); } catch { /* gone */ }
}

function printInstances(instances: Instance[]) {
  for (const inst of instances) {
    const tracked = readTrackedPid(inst.profile);
    const trackedPgid = tracked ? pidPgid(tracked) : null;
    const tag = inst.pgid === trackedPgid ? "tracked" : "orphan";
    console.log(`  profile=${inst.profile}  pgid=${inst.pgid}  [${tag}]`);
    for (const p of inst.pids) {
      console.log(`    ${p.pid.padStart(5)} ${p.ppid.padStart(5)} ${p.etime.padStart(8)}  ${p.cmd.slice(0, 100)}`);
    }
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function ensureStateDir(profile: string): void {
  const dir = dirname(statePath(profile, "pid"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function daemonStart(profile: string, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const envFile = envPathForProfile(profile);
  if (!envFile) {
    console.error(
      `ERROR: no env config for profile "${profile}". ` +
        `Run \`cronforclaude add ${profile}\` first.`,
    );
    process.exit(1);
  }
  ensureStateDir(profile);

  const existing = findInstances(profile);
  if (existing.length > 0) {
    if (!force) {
      console.error(`ERROR: a runner for profile "${profile}" is already running.`);
      printInstances(existing);
      console.error(
        `\nRun \`cronforclaude daemon stop ${profile}\` first, or ` +
          `\`cronforclaude daemon start ${profile} --force\` to kill it.`,
      );
      process.exit(1);
    }
    console.log(`Force flag set; killing ${existing.length} instance(s) first.`);
    for (const inst of existing) killGroup(inst.pgid, "SIGKILL");
    await sleep(1000);
  }

  const logFile = statePath(profile, "log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  // Strip outbound proxy vars from the child env (the parent shell may have
  // set HTTP(S)_PROXY for dev work; the runner should reach Anthropic / our
  // API direct).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;

  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1]!, "run", profile, `--profile=${profile}`],
    {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ["ignore", out, err],
    },
  );
  child.unref();

  if (child.pid == null) {
    console.error("Failed to spawn runner process.");
    process.exit(1);
  }
  writeFileSync(statePath(profile, "pid"), String(child.pid));
  await sleep(1000);
  let alive = false;
  try { process.kill(child.pid, 0); alive = true; } catch { /* dead */ }
  if (alive) {
    console.log(`Started profile=${profile}  pid=${child.pid}  log=${logFile}`);
  } else {
    console.error("Failed to start. Tail of log:");
    daemonLogs(profile, ["-n", "20"]);
    try { unlinkSync(statePath(profile, "pid")); } catch { /* ignore */ }
    process.exit(1);
  }
}

export async function daemonStop(profile?: string): Promise<void> {
  const runnerGrace = Number(process.env.SHUTDOWN_GRACE_SEC ?? 60);
  const totalGraceMs = (runnerGrace + 10) * 1000;

  const instances = findInstances(profile);
  if (instances.length === 0) {
    console.log(
      profile
        ? `Not running (no instance for profile "${profile}").`
        : "Not running.",
    );
    if (profile) {
      try { unlinkSync(statePath(profile, "pid")); } catch { /* ignore */ }
    }
    return;
  }

  console.log(
    `Sending SIGTERM to ${instances.length} instance(s); ` +
      `allowing up to ${runnerGrace}s for in-flight jobs to drain...`,
  );
  for (const inst of instances) killGroup(inst.pgid, "SIGTERM");

  const deadline = Date.now() + totalGraceMs;
  let lastReport = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    const alive = findInstances(profile);
    if (alive.length === 0) {
      console.log("Stopped cleanly.");
      for (const inst of instances) {
        try { unlinkSync(statePath(inst.profile, "pid")); } catch { /* ignore */ }
      }
      return;
    }
    const elapsed = Math.floor((totalGraceMs - (deadline - Date.now())) / 1000);
    if (elapsed - lastReport >= 5) {
      lastReport = elapsed;
      console.log(`  …still ${alive.length} alive after ${elapsed}s`);
    }
  }
  console.warn("Grace expired; SIGKILL remaining instances.");
  for (const inst of findInstances(profile)) killGroup(inst.pgid, "SIGKILL");
  for (const inst of instances) {
    try { unlinkSync(statePath(inst.profile, "pid")); } catch { /* ignore */ }
  }
}

export async function daemonRestart(profile: string): Promise<void> {
  await daemonStop(profile);
  await sleep(500);
  await daemonStart(profile, []);
}

export async function daemonStatus(): Promise<void> {
  const instances = findInstances();
  if (instances.length === 0) {
    console.log("No runners running.");
  } else {
    console.log(`${instances.length} runner instance(s) detected:`);
    printInstances(instances);
  }
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log("");
    console.log("No profiles configured. Add one with `cronforclaude add`.");
    return;
  }
  console.log("");
  console.log("Configured profiles:");
  for (const p of profiles) {
    const running = instances.some((i) => i.profile === p);
    console.log(`  ${p.padEnd(20)}  ${running ? "running" : "stopped"}`);
  }
}

export async function daemonClean(): Promise<void> {
  const instances = findInstances();
  if (instances.length === 0) {
    console.log("Nothing to clean.");
    return;
  }
  console.log(`SIGKILL on ${instances.length} instance(s).`);
  for (const inst of instances) killGroup(inst.pgid, "SIGKILL");
  for (const inst of instances) {
    try { unlinkSync(statePath(inst.profile, "pid")); } catch { /* ignore */ }
  }
}

export function daemonLogs(profile: string, args: string[]): void {
  const n = parseInt(args[args.indexOf("-n") + 1] ?? "200", 10);
  const follow = args.includes("-f");
  const log = statePath(profile, "log");
  if (!existsSync(log)) {
    console.log(`No log file yet for profile "${profile}" (${log}).`);
    return;
  }
  const tailArgs = follow ? ["-n", String(n), "-f", log] : ["-n", String(n), log];
  spawnSync("tail", tailArgs, { stdio: "inherit" });
}
