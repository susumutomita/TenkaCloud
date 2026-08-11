/**
 * Issue #2291: deterministic per-job progress logging for the Lambda deploy path.
 *
 * The CodeBuild deploy path writes its build output to a CloudWatch log stream, which
 * `handlers/participant-handler/deploy-logs.ts` streams to the participant portal. The Lambda
 * deploy path has no such stream, so a competitor would see **no** deploy progress. This tiny
 * helper appends human-readable progress lines to a `jobId`-keyed stream inside a dedicated log
 * group; `deploy-logs.ts` reads them back by naming convention (log group from the
 * `DEPLOY_JOB_LOG_GROUP` env, log stream = `jobId`).
 *
 * Everything here is default-safe: the writer only exists when the deploy Lambda is created
 * (`deployViaLambda` ON), and every caller always receives *a* logger — the inert
 * {@link NOOP_JOB_PROGRESS_LOGGER} when no log group is configured — so a `progress.info(...)`
 * call is never conditional at the call site.
 *
 * Security: callers must never pass secrets (ExternalId, credentials, the resolved random
 * password) into these lines — the stream is competitor-visible via the portal.
 */
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";

/** Minimal sink for deploy progress lines. Both progress and error lines go through `info`. */
export interface JobProgressLogger {
  info(message: string): Promise<void>;
}

/** Structural CloudWatch Logs client — only `send` is used (kept injectable for unit tests). */
interface AwsLogsSender {
  send(command: object): Promise<unknown>;
}

export interface MakeJobProgressLoggerDeps {
  readonly logs: AwsLogsSender;
  readonly logGroupName: string;
  readonly jobId: string;
  /** Injectable clock (defaults to `Date.now`) for deterministic timestamps in tests. */
  readonly now?: () => number;
}

/**
 * Build a {@link JobProgressLogger} that appends to `logGroupName`, log stream `jobId`. The stream
 * is created lazily on the first `info` and only once per instance (`streamEnsured`). An
 * already-existing stream (`ResourceAlreadyExistsException`) is ignored (idempotent); any other
 * CreateLogStream failure is rethrown (fail loud).
 */
export function makeJobProgressLogger(deps: MakeJobProgressLoggerDeps): JobProgressLogger {
  const now = deps.now ?? Date.now;
  let streamEnsured = false;

  async function ensureStream(): Promise<void> {
    if (streamEnsured) return;
    try {
      await deps.logs.send(
        new CreateLogStreamCommand({
          logGroupName: deps.logGroupName,
          logStreamName: deps.jobId,
        }),
      );
    } catch (err) {
      if (!(err instanceof ResourceAlreadyExistsException)) throw err;
    }
    streamEnsured = true;
  }

  return {
    async info(message: string): Promise<void> {
      await ensureStream();
      await deps.logs.send(
        new PutLogEventsCommand({
          logGroupName: deps.logGroupName,
          logStreamName: deps.jobId,
          logEvents: [{ timestamp: now(), message }],
        }),
      );
    },
  };
}

/**
 * Inert logger for the flag-OFF / no-log-group case, so callers can always call `info(...)`
 * unconditionally without a null check.
 */
export const NOOP_JOB_PROGRESS_LOGGER: JobProgressLogger = {
  async info(): Promise<void> {
    // intentionally does nothing
  },
};

/**
 * Best-effort progress write: swallows any failure so a CloudWatch logging error never changes the
 * deploy / delete outcome (the authoritative status still flows through DDB + the trace logs).
 */
export async function safeProgressInfo(
  progress: JobProgressLogger,
  message: string,
): Promise<void> {
  try {
    await progress.info(message);
  } catch {
    // intentionally swallowed — progress logging must not affect the deploy outcome
  }
}
