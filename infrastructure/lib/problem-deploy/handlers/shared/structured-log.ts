/**
 * Issue #1352 (parent #1336): Structured operator-facing logging helper for
 * commercial event operations.
 *
 * Why a second helper alongside `trace-log.ts`:
 *
 *   `trace-log.ts` (Issue #768) is geared toward end-to-end **deploy chain
 *   triage** (`event = "deploy.<phase>.<outcome>"`, `jobId` propagation,
 *   shell + Lambda mirrors). Its shape is optimised for "follow one job
 *   through 6 hops".
 *
 *   This helper is geared toward **event-operator diagnosis** while the event
 *   is running. The on-call operator does not know a `jobId` yet — they know
 *   "tenant X / team Y / problem Z reported a failure". The pinned shape is
 *   `{ level, ts, eventName, tenantId?, teamId?, problemId?, action, status,
 *   durationMs?, errorCode? }` so CloudWatch Logs Insights `filter tenantId =
 *   "..." and status = "failed"` answers the operator's question in one
 *   query.
 *
 *   The two helpers coexist intentionally — they are different lenses on the
 *   same logs. `trace-log` traces a request; `structured-log` summarises an
 *   operator-visible outcome.
 *
 * Secret redaction (= same allowlist pattern as Issue #1297 audit redact):
 *
 *   Operators paste error messages into incident channels. Raw error strings
 *   may contain ARNs, X-Forwarded-For IPs, presigned URL query params,
 *   ExternalId values, or JWT fragments. `redactFields` keeps only the
 *   allowlisted keys + primitive values, mirroring `redactForAudit` shallow
 *   semantics so a future contributor cannot accidentally widen the leak
 *   surface by adding nested objects.
 *
 *   Specifically NEVER log (= dropped silently even if caller passes them):
 *     - `password`, `secret`, `token`, `accessKey`, `externalId`,
 *       `presignedUrl`, `cookie`, `authorization`, `samlMetadata`,
 *       `idToken`, `accessToken`, `refreshToken`, `clientSecret`
 *     - any nested object / array / function / Date
 *
 *   `errorCode` is whitelisted as a string-typed primitive. `errorMessage`
 *   is whitelisted but length-clamped (= 240 chars) so a multi-KB AWS SDK
 *   stack trace does not blow up CloudWatch ingestion cost.
 *
 * env footprint: 0 bytes (pure code helper, no env variables added). The
 * #1310 Lambda env 3KB harness rule is therefore not affected.
 */

/** Length cap for `errorMessage` after redaction. AWS SDK errors can carry KB-scale stack traces. */
const ERROR_MESSAGE_MAX_LEN = 240;

/**
 * Allowlist of structured-log field names. Any caller-supplied key outside
 * this set is silently dropped. Mirrors the shallow-only / fail-closed
 * semantics of `redactForAudit` so secret keys cannot sneak in by
 * caller-side typos (= `externalID` vs `externalId`).
 *
 * Adding a field: confirm it is **not** secret / PII (= never an ExternalId,
 * password, JWT body, presigned URL query string, IP address, or email).
 * Operator-facing identifiers (tenantId / teamId / problemId / jobId) are OK;
 * AWS-side identifiers that are safe to log (region / awsAccountId — same
 * tenancy boundary as DDB row) are OK; numbers / status enums are OK.
 */
const FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  // correlation identifiers
  "tenantId",
  "teamId",
  "problemId",
  "eventId",
  "deploymentId",
  "jobId",
  "correlationId",
  "requestId",
  "region",
  "awsAccountId",
  // operator-visible context
  "action",
  "status",
  "outcome",
  "phase",
  "lastKnownStep",
  "participantImpact",
  // numeric / timing
  "durationMs",
  "ageSeconds",
  "attempt",
  "maxAttempts",
  // error-shape (clamped / primitive only)
  "errorCode",
  "errorMessage",
  "errorClass",
  "stackStatus",
  // operator hint
  "suggestedAction",
  "detailType",
]);

/**
 * Status enum the operator dashboard / alarm filters on. `failed` is the
 * gateway to runbook entries — anything that should page the on-call must
 * land here.
 */
export type LogStatus = "started" | "succeeded" | "failed" | "timeout" | "skipped";
export type LogLevel = "info" | "warn" | "error";

/**
 * Strict typed surface of an operator-facing log entry. Keys outside this
 * surface are redacted away. Required: `eventName`, `action`, `status`.
 *
 * `eventName` convention: `<domain>.<resource>.<verb>` — for example
 * `deploy.stack.create`, `scoring.flag.submit`, `participant.portal.login`.
 * Operators grep by domain prefix in CloudWatch Logs Insights.
 */
export interface OperatorLogFields {
  readonly eventName: string;
  readonly action: string;
  readonly status: LogStatus;
  readonly tenantId?: string;
  readonly teamId?: string;
  readonly problemId?: string;
  readonly eventId?: string;
  readonly deploymentId?: string;
  readonly jobId?: string;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly region?: string;
  readonly awsAccountId?: string;
  readonly phase?: string;
  readonly lastKnownStep?: string;
  readonly participantImpact?: "none" | "degraded" | "blocked";
  readonly durationMs?: number;
  readonly ageSeconds?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly errorClass?: string;
  readonly stackStatus?: string;
  readonly suggestedAction?: string;
  readonly detailType?: string;
  readonly outcome?: string;
}

export type RedactedLogFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Coerce + filter caller-supplied fields against the allowlist. Drops:
 *   - keys outside `FIELD_ALLOWLIST`
 *   - non-primitive values (nested object / array / Date / function / undefined)
 *
 * `errorMessage` is length-clamped to `ERROR_MESSAGE_MAX_LEN` so a multi-KB
 * AWS SDK error message does not balloon CloudWatch Logs cost.
 */
export function redactFields(fields: OperatorLogFields): RedactedLogFields {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOWLIST.has(key)) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "string") {
      out[key] = key === "errorMessage" ? clampErrorMessage(value) : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
    // object / array / undefined / function — drop silently (= fail-closed).
  }
  return out;
}

function clampErrorMessage(value: string): string {
  if (value.length <= ERROR_MESSAGE_MAX_LEN) return value;
  return `${value.slice(0, ERROR_MESSAGE_MAX_LEN - 3)}...`;
}

interface EmitOptions {
  readonly writer?: (line: string) => void;
  readonly now?: () => Date;
}

function levelToWriter(level: LogLevel): (line: string) => void {
  if (level === "error") return (line: string) => console.error(line);
  if (level === "warn") return (line: string) => console.warn(line);
  return (line: string) => console.log(line);
}

/**
 * Emit one structured operator-facing log line.
 *
 *   - `level` controls the CloudWatch console color + which `console.*` channel
 *     the line lands in (= `error` / `warn` / `log`).
 *   - `ts` is ISO-8601 (UTC). CloudWatch Logs preserves it verbatim, so
 *     Insights `sort @timestamp asc` lines up with operator wall-clock.
 *   - `component` is pinned to `problem-deploy` for cross-Lambda grep parity
 *     with `trace-log.ts`. Same Logs Insights query works for both helpers.
 *
 * Returns the rendered JSON string so unit tests can pin the wire shape
 * without spying on `console`. Production caller passes nothing (= writer
 * defaults to `console.<level>`).
 */
export function emitOperatorLog(
  level: LogLevel,
  fields: OperatorLogFields,
  options: EmitOptions = {},
): string {
  const ts = (options.now ?? (() => new Date()))().toISOString();
  const redacted = redactFields(fields);
  const payload = {
    level,
    ts,
    component: "problem-deploy",
    eventName: fields.eventName,
    ...redacted,
  };
  const line = JSON.stringify(payload);
  const writer = options.writer ?? levelToWriter(level);
  writer(line);
  return line;
}

/** Convenience: info-level emission. */
export function logOperator(fields: OperatorLogFields, options: EmitOptions = {}): string {
  return emitOperatorLog("info", fields, options);
}

/** Convenience: warn-level emission (= soft-degraded but operator should notice). */
export function warnOperator(fields: OperatorLogFields, options: EmitOptions = {}): string {
  return emitOperatorLog("warn", fields, options);
}

/** Convenience: error-level emission (= operator must act, paged status). */
export function errorOperator(fields: OperatorLogFields, options: EmitOptions = {}): string {
  return emitOperatorLog("error", fields, options);
}

/**
 * Build an `errorCode` short string from an Error subclass. Pins a stable
 * code (= class name) the operator runbook can index on, distinct from the
 * free-form `errorMessage`. Falls back to `"UnknownError"` when err is not
 * an Error instance (e.g. caller `throw "string"`).
 */
export function classifyError(err: unknown): { errorCode: string; errorMessage: string } {
  if (err instanceof Error) {
    return {
      errorCode: err.name || "Error",
      errorMessage: err.message,
    };
  }
  return {
    errorCode: "UnknownError",
    errorMessage: typeof err === "string" ? err : "non-Error thrown",
  };
}

/** Re-exported for unit tests (= internal constants intentionally kept private from prod). */
export const __test__ = {
  ERROR_MESSAGE_MAX_LEN,
  FIELD_ALLOWLIST,
};
