/**
 * Wire-protocol types + paths the runner uses to talk to the scheduler API.
 *
 * Inlined (rather than depending on @cs/shared) so this package is
 * publishable as a standalone npm module with zero workspace imports. Keep
 * in sync with `packages/shared/src/api.ts` + `packages/shared/src/types.ts`
 * in the scheduler monorepo — the runner only needs the runner-facing
 * subset.
 */

export const API_PATHS = {
  runnerHeartbeat: "/api/runner/heartbeat",
  runnerPoll: "/api/runner/poll",
  runnerJobResult: (id: string) => `/api/runner/jobs/${id}/result`,
  runnerJobLog: (id: string) => `/api/runner/jobs/${id}/log`,
} as const;

export const HEADER_RUNNER_TOKEN = "x-runner-token";

export type RunnerStatus = "online" | "draining" | "offline";

export type HeartbeatInput = {
  status?: RunnerStatus;
  runningJobIds?: string[];
  capacity?: number;
  meta?: Record<string, unknown>;
};

export type HeartbeatResponse = {
  ok: true;
  cancelled: string[];
  orphaned?: string[];
};

/** The poll endpoint returns `{ job: ClaimedJob | null }`. */
export type ClaimedJob = {
  id: string;
  scheduleId: string | null;
  projectId: string | null;
  prompt: string;
  workingDir: string | null;
  claudeArgs: string | null;
  timeoutSec: number;
  dangerouslySkipPermissions: boolean;
  effort: string;
};

export type JobClaim = {
  job: ClaimedJob | null;
};

/** A `claude -p --output-format stream-json` event. Permissive on purpose —
 *  the CLI evolves these shapes across versions. */
export type StreamEvent = {
  type: string;
  [extra: string]: unknown;
};

export type JobResultInput = {
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  events?: StreamEvent[] | null;
  startIdx?: number;
  durationMs?: number;
  error?: string | null;
};
