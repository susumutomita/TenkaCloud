/**
 * [Issue #1419 / #1666] AWS disruption live-fire — pure logic.
 *
 * The cross-account disruption chain (operator fire → EventBridge → executor Lambda → AssumeRole into
 * the competitor account → SSM RunCommand/probe inject → auto-revert) is implemented + unit-tested with
 * mocked SDKs. The one thing a mock cannot prove is the chain landing an **observable fault** in a real
 * deployed stack and reverting within its window (#1419/#1666 acceptance). That needs a real fire.
 *
 * This module is the account-free, testable core the live-fire shell relies on:
 *   - `buildFireRequest` — the exact POST body for `/events/:eventId/disruptions/fire` (verified by
 *     inspection via `--dry-run`, so the request the operator sends is correct before any live call).
 *   - `evaluateFaultTimeline` / `assessLiveFire` — judge a captured health timeline: did the target
 *     transition healthy → faulted (after the fire) → healthy (recovered) within the declared window?
 *
 * The network send + the AWS-side behavior are the only account-gated parts; everything here is pure.
 */

export interface FireRequestInput {
  readonly problemId: string;
  readonly disruptionId: string;
  readonly scope: "all" | "team" | "random-n";
  readonly targetTeamIds?: readonly string[];
  readonly randomCount?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** ≥8 chars; the platform uses it as the idempotency key (a re-fire with the same id is a no-op). */
  readonly requestId: string;
}

/** Mirrors `DisruptionFireRequestSchema` (event-handler/types.ts). Throws on the same constraints. */
export function buildFireRequest(input: FireRequestInput): Record<string, unknown> {
  if (input.requestId.length < 8 || input.requestId.length > 128) {
    throw new Error("requestId must be 8–128 chars (platform idempotency key)");
  }
  if (input.scope === "team" && !(input.targetTeamIds && input.targetTeamIds.length > 0)) {
    throw new Error("targetTeamIds is required when scope is 'team'");
  }
  if (input.scope === "random-n" && input.randomCount === undefined) {
    throw new Error("randomCount is required when scope is 'random-n'");
  }
  return {
    problemId: input.problemId,
    disruptionId: input.disruptionId,
    scope: input.scope,
    ...(input.targetTeamIds ? { targetTeamIds: input.targetTeamIds } : {}),
    ...(input.randomCount !== undefined ? { randomCount: input.randomCount } : {}),
    ...(input.parameters ? { parameters: input.parameters } : {}),
    requestId: input.requestId,
  };
}

export interface HealthSample {
  readonly atMs: number;
  /** HTTP status, or null when the request errored/timed out (treated as unhealthy). */
  readonly status: number | null;
  readonly healthy: boolean;
}

/** Build a sample, classifying healthy as "status in healthyStatuses". A null status is unhealthy. */
export function classifySample(
  atMs: number,
  status: number | null,
  healthyStatuses: readonly number[],
): HealthSample {
  return { atMs, status, healthy: status !== null && healthyStatuses.includes(status) };
}

export interface FaultTimeline {
  readonly baselineHealthy: boolean;
  readonly faultOnsetMs?: number;
  readonly recoveryMs?: number;
  readonly faulted: boolean;
  readonly recovered: boolean;
  /** Wall-clock from fault onset to recovery, when both observed. */
  readonly faultDurationMs?: number;
}

/**
 * Reduce a health timeline (sorted by `atMs`) to the fault story relative to the fire:
 * baseline health (last sample at/before `firedAtMs`), first unhealthy sample after the fire (onset),
 * and the first healthy sample after that onset (recovery).
 */
export function evaluateFaultTimeline(
  samples: readonly HealthSample[],
  firedAtMs: number,
): FaultTimeline {
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);
  const baseline = ordered.filter((s) => s.atMs <= firedAtMs).at(-1) ?? ordered.at(0);
  const baselineHealthy = baseline?.healthy ?? false;

  const after = ordered.filter((s) => s.atMs > firedAtMs);
  const onset = after.find((s) => !s.healthy);
  if (!onset) {
    return { baselineHealthy, faulted: false, recovered: false };
  }
  const recovery = after.find((s) => s.atMs > onset.atMs && s.healthy);
  return {
    baselineHealthy,
    faultOnsetMs: onset.atMs,
    faulted: true,
    recovered: recovery !== undefined,
    ...(recovery ? { recoveryMs: recovery.atMs, faultDurationMs: recovery.atMs - onset.atMs } : {}),
  };
}

export type LiveFireVerdict = "pass" | "no-baseline" | "no-fault" | "no-recovery";

export interface LiveFireAssessment {
  readonly verdict: LiveFireVerdict;
  readonly reason: string;
}

/**
 * The acceptance judgement for #1419/#1666: the fire must produce an *observable fault* that
 * *auto-reverts within the declared window*. A flat (never-faulted) timeline fails — that is the
 * "no real fault" symptom the issue is about; a faulted-but-never-recovered timeline also fails
 * because every injected disruption must auto-revert within its declared window.
 */
export function assessLiveFire(
  timeline: FaultTimeline,
  opts: { readonly maxRecoveryMs: number },
): LiveFireAssessment {
  if (!timeline.baselineHealthy) {
    return {
      verdict: "no-baseline",
      reason: "target was not healthy before the fire — cannot attribute a fault",
    };
  }
  if (!timeline.faulted) {
    return {
      verdict: "no-fault",
      reason: "no unhealthy sample after the fire — the disruption injected no observable fault",
    };
  }
  if (!timeline.recovered) {
    return {
      verdict: "no-recovery",
      reason:
        "target faulted but never recovered — auto-revert must restore every injected disruption",
    };
  }
  if ((timeline.faultDurationMs ?? Number.POSITIVE_INFINITY) > opts.maxRecoveryMs) {
    return {
      verdict: "no-recovery",
      reason: `recovery took ${timeline.faultDurationMs}ms, beyond the ${opts.maxRecoveryMs}ms window`,
    };
  }
  return {
    verdict: "pass",
    reason: `observable fault after the fire, auto-reverted in ${timeline.faultDurationMs}ms (within ${opts.maxRecoveryMs}ms)`,
  };
}
