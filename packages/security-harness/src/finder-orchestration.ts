/**
 * N-Finder orchestration (Issue #3036 Phase 2 "N Finder を独立 sandbox で並列実行する"). Real
 * sandbox isolation — filesystem/network/process boundaries between Finder runs — is
 * `TenkaCloudSimulator`'s responsibility (`AGENTS.md`'s repository boundary: "Simulator は
 * capability 実装を所有"). This file is the TenkaCloud side of that same contract: fan-out through
 * a `ModelProvider` adapter, one call per Finder task, run genuinely in parallel (`Promise.all`,
 * not a sequential loop with `await` inside it), with an isolation contract expressed as:
 *
 *   - a distinct, deterministic `FinderSessionDescriptor`/`sessionId` per task — never shared or
 *     reused across two different Finder tasks in the same run;
 *   - a freshly-built request object per task (no shared mutable reference crosses task
 *     boundaries), so one task's retries or failures cannot leak into another's in-flight request.
 *
 * The other half of this file is the "rate limit / model error / timeout の checkpoint / resume"
 * requirement: every task ends in an explicit `FinderTaskCheckpoint` with one of a closed set of
 * statuses. "No false pass" applies here exactly as it does to `evaluateFindingVerdict` /
 * `evaluatePatchVerdict`: a task that never produced a schema-valid handoff — because it exhausted
 * its retries, hit a non-retryable error, or returned unusable output — ends with a checkpoint
 * recording THAT, never a fabricated `"succeeded"`. `resumeFrom` lets a caller replay a
 * previously-recorded set of checkpoints: any task already `"succeeded"` is reused as-is and NOT
 * re-invoked (idempotent resume, matching `run-state-machine.ts`'s "re-issuing the current state
 * is a no-op success"); any task that was not yet `"succeeded"` — pending, rate-limited, timed
 * out, errored, or given invalid output — is retried fresh.
 */

import { extractFinderHandoff, type FinderHandoff } from "./finder-output.js";
import {
  isRetryableModelProviderError,
  type ModelProvider,
  type ModelProviderRequest,
} from "./model-provider.js";
import type { ReconFinderAssignment } from "./recon.js";

export type FinderTaskStatus =
  | "succeeded"
  | "rate_limited"
  | "timed_out"
  | "model_error"
  | "invalid_output"
  | "cancelled";

/**
 * The isolation contract's identity half. Two Finder tasks in the same run never share a
 * `sessionId`; a resumed run reuses the same id for the same `(runId, finderIndex)` pair, so a
 * real execution plane (Simulator) can key its own workspace/network isolation off a stable value.
 */
export interface FinderSessionDescriptor {
  readonly runId: string;
  readonly finderIndex: number;
  readonly focusArea: string;
  readonly sessionId: string;
}

export interface FinderTaskCheckpoint {
  readonly finderIndex: number;
  readonly focusArea: string;
  readonly status: FinderTaskStatus;
  readonly attempts: number;
  /** Present if and only if `status === "succeeded"`. */
  readonly handoff?: FinderHandoff;
  readonly errors: readonly string[];
}

export interface FinderRetryPolicy {
  readonly maxAttempts: number;
}

export interface FinderPrompt {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
}

export interface RunFindersOptions {
  readonly runId: string;
  readonly assignments: readonly ReconFinderAssignment[];
  readonly adapter: ModelProvider;
  readonly buildPrompt: (focusArea: string) => FinderPrompt;
  readonly retryPolicy?: FinderRetryPolicy;
  /**
   * Checkpoints from an earlier attempt at this run. A task whose prior checkpoint status is
   * `"succeeded"` is reused as-is and the adapter is NOT called for it again — see the file doc
   * comment on why re-invoking a model for already-evidenced work is both wasteful and, for a
   * live (non-deterministic) provider, a risk of silently replacing audited evidence.
   */
  readonly resumeFrom?: readonly FinderTaskCheckpoint[];
  /** Injectable retry backoff — deterministic tests pass a no-op; this package never calls a real timer directly. */
  readonly wait?: (attempt: number) => Promise<void>;
  readonly shouldCancel?: () => boolean;
}

export interface RunFindersResult {
  readonly checkpoints: readonly FinderTaskCheckpoint[];
}

const DEFAULT_RETRY_POLICY: FinderRetryPolicy = { maxAttempts: 3 };

function sessionIdFor(runId: string, finderIndex: number): string {
  return `${runId}-finder-${finderIndex}`;
}

function statusForErrorKind(
  kind: "rate_limited" | "timeout" | "transport_error" | "invalid_response",
): FinderTaskStatus {
  if (kind === "rate_limited") return "rate_limited";
  if (kind === "timeout") return "timed_out";
  return "model_error";
}

interface RunOneFinderTaskParams {
  readonly runId: string;
  readonly assignment: ReconFinderAssignment;
  readonly adapter: ModelProvider;
  readonly buildPrompt: RunFindersOptions["buildPrompt"];
  readonly retryPolicy: FinderRetryPolicy;
  readonly wait: (attempt: number) => Promise<void>;
  readonly shouldCancel: () => boolean;
}

/**
 * Runs ONE Finder task to completion: up to `retryPolicy.maxAttempts` calls through `adapter`,
 * retrying only errors the adapter itself marked retryable (`isRetryableModelProviderError`), and
 * schema-restricting any successful model response through `extractFinderHandoff` before it can
 * count as `"succeeded"`. Every exit from this function is an explicit, terminal
 * `FinderTaskCheckpoint` — there is no path that returns without one.
 */
async function runOneFinderTask(params: RunOneFinderTaskParams): Promise<FinderTaskCheckpoint> {
  const { runId, assignment, adapter, buildPrompt, retryPolicy, wait, shouldCancel } = params;
  const session: FinderSessionDescriptor = {
    runId,
    finderIndex: assignment.finderIndex,
    focusArea: assignment.focusArea,
    sessionId: sessionIdFor(runId, assignment.finderIndex),
  };
  const prompt = buildPrompt(session.focusArea);

  let attempts = 0;
  let lastStatus: FinderTaskStatus = "model_error";
  let lastErrors: readonly string[] = ["retry policy exhausted with zero attempts configured"];

  while (attempts < retryPolicy.maxAttempts) {
    if (shouldCancel()) {
      return {
        finderIndex: session.finderIndex,
        focusArea: session.focusArea,
        status: "cancelled",
        attempts,
        errors: [],
      };
    }
    attempts += 1;

    // A freshly-built request object every attempt, every task — never a shared mutable
    // reference another task (or another attempt) could observe or mutate.
    const request: ModelProviderRequest = {
      sessionId: session.sessionId,
      focusArea: session.focusArea,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: prompt.maxOutputTokens,
    };
    const result = await adapter.complete(request);

    if (!result.ok) {
      lastStatus = statusForErrorKind(result.error.kind);
      lastErrors = [result.error.message];
      if (isRetryableModelProviderError(result.error) && attempts < retryPolicy.maxAttempts) {
        await wait(attempts);
        continue;
      }
      return {
        finderIndex: session.finderIndex,
        focusArea: session.focusArea,
        status: lastStatus,
        attempts,
        errors: lastErrors,
      };
    }

    const extraction = extractFinderHandoff({
      focusArea: session.focusArea,
      finderIndex: session.finderIndex,
      rawOutputText: result.response.outputText,
    });
    if (!extraction.ok || extraction.handoff === undefined) {
      return {
        finderIndex: session.finderIndex,
        focusArea: session.focusArea,
        status: "invalid_output",
        attempts,
        errors: extraction.errors,
      };
    }
    return {
      finderIndex: session.finderIndex,
      focusArea: session.focusArea,
      status: "succeeded",
      attempts,
      handoff: extraction.handoff,
      errors: [],
    };
  }

  // Reached only when `retryPolicy.maxAttempts <= 0` — every iteration of the loop above returns
  // before falling through, so a positive attempt budget always exits inside the loop.
  return {
    finderIndex: session.finderIndex,
    focusArea: session.focusArea,
    status: lastStatus,
    attempts,
    errors: lastErrors,
  };
}

/**
 * Fans out one Finder task per Recon assignment, genuinely in parallel (`Promise.all` — every
 * task's first adapter call is issued before this function awaits any one task's result) and in
 * per-task isolation (see the file doc comment). A task whose `resumeFrom` checkpoint already says
 * `"succeeded"` is returned unchanged without calling the adapter again.
 */
export async function runFinders(options: RunFindersOptions): Promise<RunFindersResult> {
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const wait = options.wait ?? ((): Promise<void> => Promise.resolve());
  const shouldCancel = options.shouldCancel ?? ((): boolean => false);
  const resumeByIndex = new Map<number, FinderTaskCheckpoint>(
    (options.resumeFrom ?? []).map((checkpoint) => [checkpoint.finderIndex, checkpoint]),
  );

  const checkpoints = await Promise.all(
    options.assignments.map(async (assignment) => {
      const previous = resumeByIndex.get(assignment.finderIndex);
      if (previous !== undefined && previous.status === "succeeded") {
        return previous;
      }
      return runOneFinderTask({
        runId: options.runId,
        assignment,
        adapter: options.adapter,
        buildPrompt: options.buildPrompt,
        retryPolicy,
        wait,
        shouldCancel,
      });
    }),
  );

  return { checkpoints };
}
