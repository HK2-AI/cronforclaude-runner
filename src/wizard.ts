import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hostname } from "node:os";
import {
  DEFAULT_PROFILE,
  hasManagedProfile,
  profilePath,
  writeProfile,
  type ProfileFields,
} from "./profile.js";

type AddOptions = {
  profile: string;
  token?: string;
  name?: string;
  tags?: string;
  url?: string;
  claudeBin?: string;
  concurrent?: number;
  /** Force-overwrite an existing profile of the same name. */
  force?: boolean;
  /** Skip prompts; require all fields via flags / env. */
  nonInteractive?: boolean;
};

const DEFAULT_URL = "https://cronforclaude.com";

export async function runAdd(opts: AddOptions): Promise<void> {
  const target = opts.profile || DEFAULT_PROFILE;

  if (hasManagedProfile(target) && !opts.force) {
    console.error(
      `\nA profile named "${target}" already exists.\n` +
        `Use --force to overwrite, or pass a different name: cronforclaude add ${target}-2\n`,
    );
    process.exit(1);
  }

  if (opts.nonInteractive) {
    const fields = collectNonInteractive(target, opts);
    finalize(target, fields);
    return;
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log("");
    console.log(`Configuring runner profile "${target}".`);
    console.log("Press Enter to accept the value shown in brackets.");
    console.log("");

    const url = (await ask(rl, "Scheduler URL", opts.url ?? DEFAULT_URL)) || DEFAULT_URL;
    const token = await askRequired(
      rl,
      "Runner token (starts with csr_live_)",
      opts.token,
      validateToken,
    );
    const name =
      (await ask(rl, "Runner name", opts.name ?? hostname())) || hostname();
    const tags = await ask(
      rl,
      "Tags (comma-separated, blank = any)",
      opts.tags ?? "",
    );
    const claudeBin = await ask(
      rl,
      "Claude binary (path or just 'claude')",
      opts.claudeBin ?? "claude",
    );
    const concurrentStr = await ask(
      rl,
      "Max concurrent jobs",
      String(opts.concurrent ?? 1),
    );
    const concurrent = Number(concurrentStr) || 1;

    const fields: ProfileFields = {
      schedulerUrl: url,
      token,
      name,
      tags: tags || undefined,
      claudeBin,
      maxConcurrent: concurrent,
    };
    finalize(target, fields);
  } finally {
    rl.close();
  }
}

function collectNonInteractive(target: string, opts: AddOptions): ProfileFields {
  const token = opts.token ?? process.env.RUNNER_TOKEN;
  if (!token) fail(`Missing --token. Either pass it or omit --non-interactive.`);
  if (!validateToken(token).ok) fail(validateToken(token).message!);
  return {
    schedulerUrl: opts.url ?? process.env.SCHEDULER_URL ?? DEFAULT_URL,
    token,
    name: opts.name ?? process.env.RUNNER_NAME ?? hostname(),
    tags: opts.tags ?? process.env.RUNNER_TAGS,
    claudeBin: opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude",
    maxConcurrent: opts.concurrent ?? Number(process.env.MAX_CONCURRENT_JOBS ?? 1),
  };
}

function finalize(target: string, fields: ProfileFields): void {
  const path = writeProfile(target, fields);
  console.log("");
  console.log(`✓ Wrote ${path}`);
  console.log("");
  console.log("Next steps:");
  console.log("  Start in the foreground (Ctrl-C to stop):");
  console.log(`    cronforclaude run ${target}`);
  console.log("");
  console.log("  Start as a detached daemon:");
  console.log(`    cronforclaude daemon start ${target}`);
  console.log("");
  console.log("  Check status / logs:");
  console.log(`    cronforclaude daemon status`);
  console.log(`    cronforclaude daemon logs ${target} -f`);
  console.log("");
}

async function ask(
  rl: readline.Interface,
  question: string,
  defaultValue: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askRequired(
  rl: readline.Interface,
  question: string,
  initial: string | undefined,
  validate: (v: string) => { ok: boolean; message?: string },
): Promise<string> {
  let current = initial ?? "";
  while (true) {
    const suffix = current ? ` [${maskToken(current)}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    const value = answer || current;
    if (!value) {
      console.log("  This value is required.");
      continue;
    }
    const v = validate(value);
    if (!v.ok) {
      console.log(`  ${v.message}`);
      continue;
    }
    return value;
  }
}

function maskToken(t: string): string {
  if (t.length <= 14) return "***";
  return t.slice(0, 12) + "…" + t.slice(-4);
}

function validateToken(t: string): { ok: boolean; message?: string } {
  if (!t.startsWith("csr_")) {
    return { ok: false, message: "Token should start with csr_ (you can paste it from the dashboard)." };
  }
  if (t.length < 20) return { ok: false, message: "Token looks too short." };
  return { ok: true };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
