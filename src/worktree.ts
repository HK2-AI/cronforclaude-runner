/**
 * Per-job git-worktree isolation.
 *
 * When the server tells the runner a job has `useWorktree=true`, we set up a
 * detached `git worktree add -d` of the schedule's workingDir, run claude in
 * that worktree, and tear it down on completion. Detached so we never claim
 * a branch (avoids the "branch already checked out elsewhere" error if the
 * user happens to be working in the repo at the same time).
 *
 * Hard requirement: `workingDir` must be inside a git repo. If it isn't, we
 * surface that as a job error rather than silently running in the original
 * workingDir — the whole point of opting-in to a worktree is isolation.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type WorktreeHandle = {
  /** Path the job should use as cwd. */
  cwd: string;
  /** Idempotent cleanup — safe to call multiple times. */
  cleanup: () => void;
};

function gitOk(args: string[], cwd?: string): { stdout: string; stderr: string } | null {
  const r = spawnSync("git", args, { encoding: "utf8", cwd });
  if (r.status !== 0) return null;
  return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** Sentinel value the server sends when the user picked "default branch" in
 *  the UI — git rejects refs containing `:`, so this can't collide with a
 *  real branch name. */
export const DEFAULT_BRANCH_SENTINEL = ":default";

/**
 * Translate the wire `worktreeBranch` value into a real git ref the runner
 * can pass to `git worktree add -d`.
 *
 *   null / undefined / ""  → "HEAD"
 *   ":default"             → repo default branch (via origin/HEAD, then
 *                            falls back to `main`, then `master`)
 *   anything else          → passed through verbatim
 *
 * Throws with a useful message when `:default` can't be resolved, so the
 * job fails clearly instead of silently checking out HEAD.
 */
export function resolveBranchRef(repoRoot: string, requested: string | null | undefined): string {
  if (!requested) return "HEAD";
  if (requested !== DEFAULT_BRANCH_SENTINEL) return requested;

  // Prefer the symbolic ref the remote advertised (`refs/remotes/origin/HEAD`
  // → e.g. `origin/main`). Strip the `origin/` prefix so the result is a
  // local branch name git can resolve in this clone.
  const sym = gitOk(["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym?.stdout) return sym.stdout.replace(/^origin\//, "");

  // Bare repo or no origin: probe the conventional names. We test for the
  // ref's existence with `rev-parse --verify` because a fresh `init` might
  // not have either, and we want to error loudly rather than silently
  // checkout HEAD when the user explicitly asked for the default branch.
  for (const name of ["main", "master"]) {
    if (gitOk(["-C", repoRoot, "rev-parse", "--verify", "--quiet", name])) return name;
  }

  throw new Error(
    "worktreeBranch=:default but could not resolve a default branch " +
      "(no origin/HEAD, no `main`, no `master`). Pick a specific branch " +
      "or change the schedule to 'current branch'.",
  );
}

/**
 * Create a detached worktree of `workingDir` starting at the requested ref
 * for this job. Throws with a human-readable message that the caller
 * should propagate as the job error.
 */
export function setupWorktree(
  workingDir: string,
  jobId: string,
  branch: string | null | undefined,
): WorktreeHandle {
  // 1. Confirm workingDir is inside a git repo. We resolve to the repo root
  //    so the worktree commands work the same whether the user pointed
  //    workingDir at the repo root or a sub-directory.
  const top = gitOk(["-C", workingDir, "rev-parse", "--show-toplevel"]);
  if (!top || !top.stdout) {
    throw new Error(
      `useWorktree=true but '${workingDir}' is not inside a git repo. ` +
        `Either turn the toggle off, or 'git init' the directory.`,
    );
  }
  const repoRoot = top.stdout;

  // 2. Mint a unique tmp dir — sibling of the system tmpdir, tagged with
  //    the repo name + first 8 chars of the job id so it's grep-able if it
  //    ever leaks past cleanup.
  const wtPath = mkdtempSync(
    join(tmpdir(), `cs-wt-${basename(repoRoot)}-${jobId.slice(0, 8)}-`),
  );

  // 3. Resolve the requested branch into a concrete ref. `:default` requires
  //    a git call to look up origin/HEAD; everything else passes through.
  let ref: string;
  try {
    ref = resolveBranchRef(repoRoot, branch);
  } catch (e) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* tmpdir was empty; safe to ignore */
    }
    throw e;
  }

  // 4. `git worktree add -d <path> <ref>` creates a detached checkout at
  //    the ref. --force lets us reuse the path if mkdtempSync raced with
  //    another process (shouldn't happen but is harmless).
  const add = spawnSync(
    "git",
    ["-C", repoRoot, "worktree", "add", "-d", "--force", wtPath, ref],
    { encoding: "utf8" },
  );
  if (add.status !== 0) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* the worktree never came up, the dir was empty; safe to ignore */
    }
    throw new Error(
      `git worktree add failed for '${repoRoot}': ${(add.stderr || add.stdout || "unknown").trim()}`,
    );
  }

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    // `worktree remove --force` deletes the working files AND prunes the
    // worktree metadata under .git/worktrees. Errors are swallowed; the
    // job is already done and we don't want cleanup failures to mask it.
    spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath], {
      encoding: "utf8",
    });
    // Belt-and-braces: in case `git worktree remove` left anything behind
    // (e.g. user dropped a build artefact outside .git tracking), nuke
    // the directory directly. Still no-throw.
    try {
      if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* nothing else to do */
    }
  };

  return { cwd: wtPath, cleanup };
}
