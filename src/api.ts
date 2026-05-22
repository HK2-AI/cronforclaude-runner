import {
  API_PATHS,
  HEADER_RUNNER_TOKEN,
  type HeartbeatInput,
  type HeartbeatResponse,
  type JobClaim,
  type JobResultInput,
  type StreamEvent,
} from "./wire.js";
import { config } from "./config.js";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(config.schedulerUrl + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      [HEADER_RUNNER_TOKEN]: config.token,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export type LogResponse = { ok: true; cancelled: boolean };

export const api = {
  heartbeat(payload: HeartbeatInput) {
    return call<HeartbeatResponse>(API_PATHS.runnerHeartbeat, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  poll() {
    return call<JobClaim>(API_PATHS.runnerPoll, { method: "POST", body: "{}" });
  },
  jobLog(id: string, payload: { status?: "running"; stdout?: string; stderr?: string; events?: StreamEvent[]; startIdx?: number }) {
    return call<LogResponse>(API_PATHS.runnerJobLog(id), {
      method: "POST",
      body: JSON.stringify({
        status: payload.status ?? "running",
        stdout: payload.stdout,
        stderr: payload.stderr,
        events: payload.events,
        startIdx: payload.startIdx,
      }),
    });
  },
  jobResult(id: string, payload: JobResultInput) {
    return call(API_PATHS.runnerJobResult(id), {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
