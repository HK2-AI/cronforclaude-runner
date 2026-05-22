import { spawn } from "node:child_process";
import { config } from "./config.js";

export type StreamEvent = { type: string; [k: string]: unknown };

export type ExecResult = {
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  exitCode: number | null;
  /** Human-readable text extracted from the stream-json `result` event (or
   *  concatenated assistant message text when no `result` event arrived). For
   *  legacy plain-output mode this is just the raw stdout. */
  stdout: string;
  stderr: string;
  /** Tail of events not yet flushed at process exit (delta starting at
   *  `eventsStartIdx`). The /result endpoint appends them so the final flush
   *  is never lost. Empty when /log already saw the last event, or when
   *  streaming is disabled (user supplied their own `--output-format`). */
  events: StreamEvent[];
  /** Index of `events[0]` in the conceptual full event stream for this job. */
  eventsStartIdx: number;
  durationMs: number;
  error?: string;
};

export type FlushFn = (snapshot: {
  stdout: string;
  stderr: string;
  /** Only set when new events arrived since the previous flush. The server
   *  appends them to JobEvent rows; idempotent via (jobId,idx) primary key. */
  events?: StreamEvent[];
  /** Index of `events[0]` in the conceptual full event stream. */
  startIdx?: number;
}) => Promise<{ cancelled: boolean }>;

/** Handle returned alongside the exec promise so external code (e.g. graceful
 *  shutdown) can request a cancel and wait for the promise to settle. */
export type ExecHandle = {
  promise: Promise<ExecResult>;
  /** Trigger graceful cancellation: SIGTERM the process group, then SIGKILL
   *  after `hardKillAfterMs` ms. The exec promise resolves with status
   *  "cancelled" on completion. Idempotent. */
  cancel: (hardKillAfterMs?: number) => void;
};

function parseArgs(s: string | null | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && /\s/.test(c!)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const MAX_BUF = 1_000_000; // 1MB per stream
const MAX_EVENTS = 10_000;
const FLUSH_INTERVAL_MS = 2000;

/** Pull the human-readable answer out of a stream-json event log. We prefer
 *  the final `result` event (which the CLI fills with the assistant's last
 *  message), and fall back to concatenating every assistant text block in
 *  order so a partial/early-exited run still shows something. */
function extractText(events: StreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "result" && typeof e.result === "string") return e.result;
  }
  const parts: string[] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const msg = (e as { message?: { content?: unknown } }).message;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
  }
  return parts.join("\n");
}

export function execClaude(opts: {
  prompt: string;
  workingDir?: string | null;
  claudeArgs?: string | null;
  timeoutSec: number;
  dangerouslySkipPermissions?: boolean;
  effort?: string | null;
  flush?: FlushFn;
}): ExecHandle {
  const start = Date.now();
  const extra = parseArgs(opts.claudeArgs);
  if (opts.dangerouslySkipPermissions && !extra.includes("--dangerously-skip-permissions")) {
    extra.unshift("--dangerously-skip-permissions");
  }
  // Apply effort flag unless the user already specified one via claudeArgs.
  if (opts.effort && !extra.some((a) => a === "--effort" || a.startsWith("--effort="))) {
    extra.unshift("--effort", opts.effort);
  }
  // Force streaming output unless the user explicitly chose another format.
  // `--verbose` is required by the CLI when `--output-format stream-json` is set.
  const userPickedFormat = extra.some((a, i) => a === "--output-format" || a.startsWith("--output-format=") || (a === "-o" && i + 1 < extra.length));
  const streaming = !userPickedFormat;
  if (streaming) {
    extra.push("--output-format", "stream-json", "--verbose");
  }
  const args = ["-p", opts.prompt, ...extra];
  const child = spawn(config.claudeBin, args, {
    cwd: opts.workingDir || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  function killGroup(signal: NodeJS.Signals = "SIGKILL") {
    if (child.pid == null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  }

  let rawStdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let truncatedOut = false;
  let truncatedErr = false;
  let truncatedEvents = false;
  let resolved = false;
  let cancelRequested = false;
  let cancelReason: string | null = null;
  let resolveExec: (r: ExecResult) => void = () => {};

  // Stream-json parsing: buffer partial lines, emit each completed JSON line
  // as a StreamEvent.
  let lineBuf = "";
  const events: StreamEvent[] = [];

  function ingestLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as StreamEvent;
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        if (events.length < MAX_EVENTS) events.push(obj);
        else truncatedEvents = true;
      }
    } catch {
      // Not valid JSON — likely a stray log line from a child process. Ignore;
      // the raw stdout already captured it.
    }
  }

  function finalStdout(): string {
    if (streaming) {
      // Hand the UI the extracted text, not the raw JSON stream.
      const text = extractText(events);
      return truncatedEvents ? text + "\n...[event log truncated]" : text;
    }
    return truncatedOut ? rawStdout + "\n...[truncated]" : rawStdout;
  }
  function finalStderr() {
    return truncatedErr ? stderr + "\n...[truncated]" : stderr;
  }

  const promise = new Promise<ExecResult>((resolve) => { resolveExec = resolve; });

  child.stdout.on("data", (b: Buffer) => {
    const chunk = b.toString("utf8");
    if (stdoutBytes < MAX_BUF) {
      stdoutBytes += chunk.length;
      if (!streaming) rawStdout += chunk;
    } else {
      truncatedOut = true;
    }
    if (streaming) {
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        ingestLine(line);
      }
    }
  });
  child.stderr.on("data", (b: Buffer) => {
    if (stderr.length < MAX_BUF) stderr += b.toString("utf8");
    else truncatedErr = true;
  });

  function settle(result: ExecResult) {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    clearInterval(flushTimer);
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 1000);
    resolveExec(result);
  }

  // Position of the next event to send. Anything before this index has been
  // accepted by the server (via /log) and must not be re-sent. /result picks
  // up whatever's still after this when the process exits.
  let lastFlushedEventCount = 0;

  function eventsTail(): { events: StreamEvent[]; startIdx: number } {
    if (!streaming) return { events: [], startIdx: 0 };
    return { events: events.slice(lastFlushedEventCount), startIdx: lastFlushedEventCount };
  }

  const timer = setTimeout(() => {
    killGroup("SIGKILL");
    const tail = eventsTail();
    settle({
      status: "timeout",
      exitCode: null,
      stdout: finalStdout(),
      stderr: finalStderr(),
      events: tail.events,
      eventsStartIdx: tail.startIdx,
      durationMs: Date.now() - start,
      error: `timeout after ${opts.timeoutSec}s`,
    });
  }, opts.timeoutSec * 1000);

  // Periodic flush: always ping (even when no new output) so we learn about
  // server-initiated cancels mid-flight. When new events have arrived we send
  // only the delta — the server appends them to JobEvent, so each /log POST
  // is small regardless of how long the job has been running.
  const flushTimer = setInterval(async () => {
    if (resolved || !opts.flush) return;
    const startIdx = lastFlushedEventCount;
    const newEvents = streaming ? events.slice(startIdx) : [];
    const snapshot = {
      stdout: finalStdout(),
      stderr: finalStderr(),
      ...(newEvents.length > 0 ? { events: newEvents, startIdx } : {}),
    };
    try {
      const { cancelled } = await opts.flush(snapshot);
      if (newEvents.length > 0) lastFlushedEventCount = startIdx + newEvents.length;
      if (cancelled && !cancelRequested) {
        requestCancel("cancelled by server", 2000);
      }
    } catch {
      // Network blip; try again next interval. lastFlushedEventCount stays put
      // so the next attempt re-sends the same delta. The server's
      // (jobId,idx) PK makes the retry a no-op if it actually landed.
    }
  }, FLUSH_INTERVAL_MS);

  function requestCancel(reason: string, hardKillAfterMs: number) {
    if (cancelRequested) return;
    cancelRequested = true;
    cancelReason = reason;
    killGroup("SIGTERM");
    setTimeout(() => {
      if (!resolved) killGroup("SIGKILL");
    }, hardKillAfterMs);
  }

  child.on("error", (e) => {
    const tail = eventsTail();
    settle({
      status: "failed",
      exitCode: null,
      stdout: finalStdout(),
      stderr: finalStderr(),
      events: tail.events,
      eventsStartIdx: tail.startIdx,
      durationMs: Date.now() - start,
      error: e.message,
    });
  });

  child.on("close", (code) => {
    // Flush any trailing partial line.
    if (streaming && lineBuf.length > 0) {
      ingestLine(lineBuf);
      lineBuf = "";
    }
    const status: ExecResult["status"] = cancelRequested
      ? "cancelled"
      : code === 0
        ? "succeeded"
        : "failed";
    const tail = eventsTail();
    settle({
      status,
      exitCode: code,
      stdout: finalStdout(),
      stderr: finalStderr(),
      events: tail.events,
      eventsStartIdx: tail.startIdx,
      durationMs: Date.now() - start,
      error: cancelReason ?? undefined,
    });
  });

  return {
    promise,
    cancel(hardKillAfterMs = 2000) { requestCancel("cancelled by runner shutdown", hardKillAfterMs); },
  };
}
