import { MANAGED_BY_ALWAYS_ON_RUNTIME } from "../runtime-tags.js";

/**
 * Issue #2293 — the **pure** cleanup-sweeper core.
 *
 * This is the loud-failure safety net against cost leaks from event-runtime stacks that were never
 * torn down. It scans CloudFormation stacks tagged `TenkaCloud:ManagedBy=always-on-runtime` whose
 * `TenkaCloud:ExpiresAt` is in the past, retries `DeleteStack` a bounded number of times, and — on
 * exhausted failure — OPENS A GITHUB ISSUE naming the stuck stack (no silent fallback, per repo
 * policy). It NEVER touches a stack that lacks the `always-on-runtime` ManagedBy tag, so Lite /
 * SaaS / competitor stacks are safe by construction.
 *
 * The core is dependency-injected and free of AWS / GitHub SDK imports so it is fully offline-
 * testable. The real edges live in the thin adapters ({@link ./cfn-stacks-client.ts},
 * {@link ./github-issue-filer.ts}) wired together by {@link ./index.ts}.
 */

/** A CloudFormation stack projected down to just the tags the sweeper reasons about. */
export interface ManagedStack {
  /** CloudFormation stack name. */
  readonly stackName: string;
  /** `TenkaCloud:ManagedBy` tag value (absent on Lite/SaaS/competitor stacks). */
  readonly managedBy?: string;
  /** `TenkaCloud:ExpiresAt` tag value (ISO-8601). */
  readonly expiresAt?: string;
  /** `TenkaCloud:TenantId` tag value. */
  readonly tenantId?: string;
  /** `TenkaCloud:EventId` tag value. */
  readonly eventId?: string;
  /** Stack output naming the raw score-event archive Lambda. */
  readonly archiveFunctionName?: string;
}

/** The CloudFormation edge the sweeper needs (list managed stacks + delete one by name). */
export interface CfnStacksClient {
  /** List every stack with its `TenkaCloud:*` tags projected. Rejects loudly on an API error. */
  listManagedStacks(): Promise<readonly ManagedStack[]>;
  /** Issue `DeleteStack` for one stack by name. Rejects on failure (the sweeper retries). */
  deleteStack(stackName: string): Promise<void>;
  /** Invoke the stack's archive function before deletion. Rejects on function/API failure. */
  archiveStack(archiveFunctionName: string, eventId: string): Promise<void>;
}

/** A cleanup that exhausted all retries — the payload the sweeper turns into a GitHub issue. */
export interface CleanupFailure {
  readonly stackName: string;
  readonly attempts: number;
  readonly lastError: string;
}

/** The loud-failure edge: open a GitHub issue naming a stack that would not delete. */
export interface IssueFiler {
  openCleanupFailureIssue(failure: CleanupFailure): Promise<void>;
}

export interface SweepDeps {
  /** CloudFormation edge (list + delete). */
  readonly stacks: CfnStacksClient;
  /** GitHub issue edge (loud failure). */
  readonly issues: IssueFiler;
  /** Bounded delete retries per stack. Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

export interface SweepSummary {
  /** Total stacks returned by the listing. */
  readonly scanned: number;
  /** Stacks that are always-on-runtime AND past their expiry (the sweep candidates). */
  readonly expired: number;
  /** Candidates successfully deleted (possibly after retries). */
  readonly deleted: number;
  /** Candidates that failed every retry — one GitHub issue was filed per such stack. */
  readonly failed: number;
}

/** Default bounded retry count for `DeleteStack` before the sweeper files a loud issue. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Parse an `ExpiresAt` tag to a Date, or `undefined` if absent / unparseable. */
function parseExpiry(expiresAt: string | undefined): Date | undefined {
  if (!expiresAt) return undefined;
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The safety predicate: a stack is a sweep candidate ONLY when it is tagged
 * `TenkaCloud:ManagedBy=always-on-runtime` AND its parsed `ExpiresAt` is strictly before `now`.
 *
 * A stack without the always-on ManagedBy tag, or with a missing / unparseable expiry, is never a
 * candidate. This is why the sweeper can never delete a Lite/SaaS stack: those never carry the tag.
 */
function isExpiredAlwaysOnStack(stack: ManagedStack, now: Date): boolean {
  if (stack.managedBy !== MANAGED_BY_ALWAYS_ON_RUNTIME) return false;
  const expiry = parseExpiry(stack.expiresAt);
  if (expiry === undefined) return false;
  return expiry.getTime() < now.getTime();
}

/** Outcome of the bounded delete-with-retry for one stack. */
type DeleteOutcome =
  | { readonly ok: true; readonly attempts: number }
  | { readonly ok: false; readonly attempts: number; readonly lastError: string };

/** Try `DeleteStack` up to `maxAttempts` times; report the last error if all attempts fail. */
async function deleteWithRetry(
  stacks: CfnStacksClient,
  stackName: string,
  maxAttempts: number,
): Promise<DeleteOutcome> {
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await stacks.deleteStack(stackName);
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, attempts: maxAttempts, lastError };
}

async function archiveWithRetry(
  stacks: CfnStacksClient,
  stack: ManagedStack,
  maxAttempts: number,
): Promise<DeleteOutcome> {
  if (!stack.eventId || !stack.archiveFunctionName) {
    return {
      ok: false,
      attempts: 0,
      lastError: "eventId or ArchiveFunctionName is missing; refusing deletion without archive",
    };
  }
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await stacks.archiveStack(stack.archiveFunctionName, stack.eventId);
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, attempts: maxAttempts, lastError };
}

/**
 * Sweep every expired always-on runtime stack: delete-with-retry each candidate, and file exactly
 * one GitHub issue per candidate that exhausts its retries. Returns a `{ scanned, expired, deleted,
 * failed }` summary. A listing failure propagates (fail loud — the sweep is not silently a no-op).
 */
export async function sweepExpiredRuntimes(deps: SweepDeps, now: Date): Promise<SweepSummary> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const all = await deps.stacks.listManagedStacks();
  const expired = all.filter((stack) => isExpiredAlwaysOnStack(stack, now));

  let deleted = 0;
  let failed = 0;
  for (const stack of expired) {
    const archive = await archiveWithRetry(deps.stacks, stack, maxAttempts);
    if (!archive.ok) {
      failed += 1;
      await deps.issues.openCleanupFailureIssue({
        stackName: stack.stackName,
        attempts: archive.attempts,
        lastError: `archive failed: ${archive.lastError}`,
      });
      continue;
    }
    const outcome = await deleteWithRetry(deps.stacks, stack.stackName, maxAttempts);
    if (outcome.ok) {
      deleted += 1;
    } else {
      failed += 1;
      await deps.issues.openCleanupFailureIssue({
        stackName: stack.stackName,
        attempts: outcome.attempts,
        lastError: outcome.lastError,
      });
    }
  }

  return { scanned: all.length, expired: expired.length, deleted, failed };
}
