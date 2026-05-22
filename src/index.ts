#!/usr/bin/env node

import { config as loadDotenv } from "dotenv";
import {
  DEFAULT_PROFILE,
  deleteProfile,
  envPathForProfile,
  listProfiles,
} from "./profile.js";

// CLI flag → env var override. Applied AFTER dotenv but BEFORE config.ts is
// imported, so flags win over the .env file. Long-form via --profile=NAME is
// handled separately below.
const FLAG_TO_ENV: Record<string, string> = {
  "--concurrent":   "MAX_CONCURRENT_JOBS",
  "-c":             "MAX_CONCURRENT_JOBS",
  "--name":         "RUNNER_NAME",
  "--token":        "RUNNER_TOKEN",
  "--url":          "SCHEDULER_URL",
  "--claude-bin":   "CLAUDE_BIN",
  "--poll-ms":      "POLL_INTERVAL_MS",
  "--heartbeat-ms": "HEARTBEAT_INTERVAL_MS",
  "--tags":         "RUNNER_TAGS",
};

function usage(exitCode = 1): never {
  console.error(`Usage:
  cronforclaude add [profile] [flags]                  interactive setup wizard
  cronforclaude run [profile]                          foreground (default profile)
  cronforclaude ls                                     list configured profiles
  cronforclaude rm <profile>                           delete a profile
  cronforclaude daemon start [profile] [--force]       spawn detached
  cronforclaude daemon stop [profile]                  SIGTERM + grace + SIGKILL
  cronforclaude daemon restart [profile]
  cronforclaude daemon status                          all tracked + orphan instances
  cronforclaude daemon clean                           SIGKILL every runner instance
  cronforclaude daemon logs [profile] [-n N] [-f]      tail or follow log

\`profile\` is a name you pick (default = "default"). Each profile has its
own token, name, tags, and runs as its own process. Multiple profiles live
side-by-side without needing per-runner folders.

Setup options for \`add\`:
  --token=TOKEN           runner token (csr_live_…)
  --name=NAME             friendly name (default: hostname)
  --tags=mac,gpu          comma-separated routing tags
  --url=URL               scheduler URL (default: https://cronforclaude.com)
  --claude-bin=PATH       path to claude binary (default: "claude")
  --concurrent N          jobs in parallel (default 1)
  --non-interactive       fail if any required flag is missing instead of prompting
  --force                 overwrite an existing profile of the same name

Global flags (override profile/env values for the current command):
  --concurrent N, -c N    MAX_CONCURRENT_JOBS
  --name NAME             RUNNER_NAME
  --token TOKEN           RUNNER_TOKEN
  --url URL               SCHEDULER_URL
  --claude-bin PATH       CLAUDE_BIN
  --poll-ms N             POLL_INTERVAL_MS
  --heartbeat-ms N        HEARTBEAT_INTERVAL_MS
  --tags TAGS             RUNNER_TAGS

Examples:
  cronforclaude add                                    interactive wizard, profile = "default"
  cronforclaude add work --token=csr_live_… --tags=mac one-line non-interactive setup
  cronforclaude run work                               start the "work" profile in the foreground
  cronforclaude daemon start work --concurrent 3       detached, with override
  cronforclaude daemon logs work -f                    tail the work-profile log
`);
  process.exit(exitCode);
}

/** Parse "--profile=NAME" out of argv, mutating the array. */
function takeProfileFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--profile=")) {
      argv.splice(i, 1);
      return a.slice("--profile=".length);
    }
    if (a === "--profile") {
      const v = argv[i + 1];
      argv.splice(i, 2);
      if (!v) {
        console.error("Missing value for --profile");
        process.exit(1);
      }
      return v;
    }
  }
  return null;
}

/** Strip recognised global flags from argv and apply them to process.env. */
function parseGlobalFlags(argv: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Long-form key=value (e.g. --token=csr_live_…)
    const eq = a.indexOf("=");
    if (eq > 0) {
      const key = a.slice(0, eq);
      if (key in FLAG_TO_ENV) {
        process.env[FLAG_TO_ENV[key]!] = a.slice(eq + 1);
        continue;
      }
    }
    if (a in FLAG_TO_ENV) {
      const v = argv[++i];
      if (v == null) {
        console.error(`Missing value for ${a}`);
        process.exit(1);
      }
      process.env[FLAG_TO_ENV[a]!] = v;
      continue;
    }
    positional.push(a);
  }
  return positional;
}

/** Load the right .env for the given profile, if any. Caller does this before
 *  importing config so process.env is populated before config.ts runs. */
function loadProfileEnv(profile: string): void {
  const p = envPathForProfile(profile);
  if (p) loadDotenv({ path: p });
}

async function cmdAdd(positional: string[], argv: string[]): Promise<void> {
  const profile = positional[1] || DEFAULT_PROFILE;
  const flags: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq > 0) flags[raw.slice(2, eq)] = raw.slice(eq + 1);
    else flags[raw.slice(2)] = true;
  }
  const { runAdd } = await import("./wizard.js");
  await runAdd({
    profile,
    token: typeof flags.token === "string" ? flags.token : undefined,
    name: typeof flags.name === "string" ? flags.name : undefined,
    tags: typeof flags.tags === "string" ? flags.tags : undefined,
    url: typeof flags.url === "string" ? flags.url : undefined,
    claudeBin: typeof flags["claude-bin"] === "string" ? (flags["claude-bin"] as string) : undefined,
    concurrent: typeof flags.concurrent === "string" ? Number(flags.concurrent) : undefined,
    force: flags.force === true,
    nonInteractive: flags["non-interactive"] === true,
  });
}

function cmdLs(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log("No profiles configured. Add one with `cronforclaude add`.");
    return;
  }
  for (const p of profiles) console.log(p);
}

function cmdRm(positional: string[]): void {
  const target = positional[1];
  if (!target) {
    console.error("Usage: cronforclaude rm <profile>");
    process.exit(1);
  }
  const ok = deleteProfile(target);
  console.log(ok ? `Removed profile "${target}".` : `No profile named "${target}".`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Take --profile= early so it survives parseGlobalFlags.
  const explicitProfile = takeProfileFlag(argv);
  const positional = parseGlobalFlags(argv);
  const cmd = positional[0];

  if (cmd === "-h" || cmd === "--help" || cmd === "help" || !cmd) {
    if (!cmd) {
      // No command = run the default profile (back-compat).
      const profile = explicitProfile ?? DEFAULT_PROFILE;
      loadProfileEnv(profile);
      const { runLoop } = await import("./run.js");
      await runLoop();
      return;
    }
    usage(0);
  }

  if (cmd === "add" || cmd === "init") {
    await cmdAdd(positional, process.argv.slice(2));
    return;
  }

  if (cmd === "ls" || cmd === "list") {
    cmdLs();
    return;
  }

  if (cmd === "rm" || cmd === "remove") {
    cmdRm(positional);
    return;
  }

  if (cmd === "run") {
    const profile = explicitProfile ?? positional[1] ?? DEFAULT_PROFILE;
    loadProfileEnv(profile);
    const { runLoop } = await import("./run.js");
    await runLoop();
    return;
  }

  if (cmd === "daemon") {
    const sub = positional[1];
    const rest = positional.slice(2);
    const profile = explicitProfile ?? rest.find((a) => !a.startsWith("-")) ?? DEFAULT_PROFILE;
    const flagOnlyRest = rest.filter((a) => a.startsWith("-"));
    const d = await import("./daemon.js");
    // For start, the env must be loaded so the detached child inherits the
    // resolved process.env (the child re-loads its own profile too).
    if (sub === "start" || sub === "restart") loadProfileEnv(profile);
    switch (sub) {
      case "start":   return d.daemonStart(profile, flagOnlyRest);
      case "stop":    return d.daemonStop(profile);
      case "restart": return d.daemonRestart(profile);
      case "status":  return d.daemonStatus();
      case "clean":   return d.daemonClean();
      case "logs":    return d.daemonLogs(profile, flagOnlyRest);
      default:        usage();
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
