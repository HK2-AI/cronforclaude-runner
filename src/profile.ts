/**
 * Profile management. A profile is a named runner identity stored on disk as
 * a .env file under ~/.cronforclaude/runners/<name>.env. Multiple profiles
 * live side-by-side without needing per-runner directories.
 *
 * Backwards-compat: if no profiles are configured but an in-tree
 * apps/runner/.env exists (the pre-profile setup), it's surfaced as the
 * implicit "default" profile.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT =
  process.env.CRONFORCLAUDE_HOME ?? join(homedir(), ".cronforclaude");
const RUNNERS_DIR = join(ROOT, "runners");
const STATE_DIR = join(ROOT, "state");

export const DEFAULT_PROFILE = "default";

export type ProfileFields = {
  schedulerUrl: string;
  token: string;
  name?: string;
  tags?: string;
  claudeBin?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxConcurrent?: number;
};

function ensureDirs(): void {
  if (!existsSync(RUNNERS_DIR)) mkdirSync(RUNNERS_DIR, { recursive: true });
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name);
}

export function profilePath(name: string): string {
  return join(RUNNERS_DIR, `${name}.env`);
}

export function statePath(name: string, suffix: "pid" | "log"): string {
  return join(STATE_DIR, `${name}.${suffix}`);
}

/** Top-level config root, exposed for the dashboard hint. */
export function configRoot(): string {
  return ROOT;
}

/** Legacy in-tree .env, used as "default" if no managed profile exists. */
function legacyEnvPath(): string {
  return resolve(process.cwd(), ".env");
}

export function hasManagedProfile(name: string): boolean {
  return existsSync(profilePath(name));
}

export function hasLegacyEnv(): boolean {
  return existsSync(legacyEnvPath());
}

/** Returns the env path the runner should load for the given profile, or
 *  null if neither managed nor legacy is present. */
export function envPathForProfile(name: string): string | null {
  if (hasManagedProfile(name)) return profilePath(name);
  if (name === DEFAULT_PROFILE && hasLegacyEnv()) return legacyEnvPath();
  return null;
}

export function listProfiles(): string[] {
  const out: string[] = [];
  if (existsSync(RUNNERS_DIR)) {
    for (const f of readdirSync(RUNNERS_DIR)) {
      if (f.endsWith(".env")) out.push(f.slice(0, -4));
    }
  }
  if (out.length === 0 && hasLegacyEnv()) out.push(DEFAULT_PROFILE);
  return out.sort();
}

export function readProfile(name: string): ProfileFields | null {
  const p = envPathForProfile(name);
  if (!p) return null;
  const raw = readFileSync(p, "utf8");
  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    map[m[1]!] = stripQuotes(m[2]!.trim());
  }
  if (!map.SCHEDULER_URL || !map.RUNNER_TOKEN) return null;
  return {
    schedulerUrl: map.SCHEDULER_URL,
    token: map.RUNNER_TOKEN,
    name: map.RUNNER_NAME,
    tags: map.RUNNER_TAGS,
    claudeBin: map.CLAUDE_BIN,
    pollIntervalMs: map.POLL_INTERVAL_MS ? Number(map.POLL_INTERVAL_MS) : undefined,
    heartbeatIntervalMs: map.HEARTBEAT_INTERVAL_MS ? Number(map.HEARTBEAT_INTERVAL_MS) : undefined,
    maxConcurrent: map.MAX_CONCURRENT_JOBS ? Number(map.MAX_CONCURRENT_JOBS) : undefined,
  };
}

function stripQuotes(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

export function writeProfile(name: string, fields: ProfileFields): string {
  if (!isValidProfileName(name)) {
    throw new Error(`Invalid profile name "${name}". Use letters, digits, hyphen, underscore.`);
  }
  ensureDirs();
  const lines = [
    `# cronforclaude runner profile "${name}"`,
    `# Generated ${new Date().toISOString()}`,
    `SCHEDULER_URL=${fields.schedulerUrl}`,
    `RUNNER_TOKEN=${fields.token}`,
  ];
  if (fields.name) lines.push(`RUNNER_NAME=${fields.name}`);
  if (fields.tags) lines.push(`RUNNER_TAGS=${fields.tags}`);
  if (fields.claudeBin) lines.push(`CLAUDE_BIN=${fields.claudeBin}`);
  if (fields.pollIntervalMs) lines.push(`POLL_INTERVAL_MS=${fields.pollIntervalMs}`);
  if (fields.heartbeatIntervalMs) lines.push(`HEARTBEAT_INTERVAL_MS=${fields.heartbeatIntervalMs}`);
  if (fields.maxConcurrent) lines.push(`MAX_CONCURRENT_JOBS=${fields.maxConcurrent}`);
  const p = profilePath(name);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* not critical */ }
  return p;
}

export function deleteProfile(name: string): boolean {
  const p = profilePath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
