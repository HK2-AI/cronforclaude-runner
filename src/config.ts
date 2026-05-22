// Config is built from process.env. The caller (index.ts) loads the right
// .env file for the active profile BEFORE this module is imported, so we
// just read whatever's already in process.env here.

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing env: ${name}. Run \`cronforclaude add\` to configure a profile, ` +
        `or copy apps/runner/.env.example to apps/runner/.env.`,
    );
  }
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env ${name}=${v}`);
  return n;
}

export const config = {
  schedulerUrl: req("SCHEDULER_URL").replace(/\/+$/, ""),
  token: req("RUNNER_TOKEN"),
  name: process.env.RUNNER_NAME || `runner-${process.pid}`,
  claudeBin: process.env.CLAUDE_BIN || "claude",
  pollIntervalMs: num("POLL_INTERVAL_MS", 5000),
  heartbeatIntervalMs: num("HEARTBEAT_INTERVAL_MS", 15_000),
  maxConcurrent: num("MAX_CONCURRENT_JOBS", 1),
  shutdownGraceSec: num("SHUTDOWN_GRACE_SEC", 60),
};
