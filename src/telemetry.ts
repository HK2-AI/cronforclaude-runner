import * as Sentry from "@sentry/node";
import pino from "pino";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    release: process.env.RUNNER_VERSION || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: "cronforclaude",
    name: process.env.RUNNER_NAME || `runner-${process.pid}`,
  },
  redact: {
    paths: ["token", "*.token", "RUNNER_TOKEN", "headers.authorization"],
    censor: "[REDACTED]",
  },
});

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  }
}
