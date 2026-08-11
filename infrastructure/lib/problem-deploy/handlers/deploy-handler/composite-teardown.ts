/**
 * [Composite Runtime / Issue #2071] Fan out one composite parent teardown to all
 * of its eligible target jobs, reusing the existing per-target teardown.
 *
 * This starts teardown only — it does NOT decide when the parent becomes DELETED
 * (a later reconciliation issue). It:
 *   - verifies the parent is a composite parent owned by the requesting tenant,
 *   - conditionally flips the parent to DELETING BEFORE any target teardown
 *     (a transition race when another request already moved it is a no-op),
 *   - requests teardown once for every target whose status is not deleted-like,
 *     via the existing per-target teardown function (so AWS keeps its EventBridge
 *     / Step Functions delete path and GCP/Azure/Sakura keep their adapter.destroy
 *     path), and
 *   - continues after a single target failure, returning one outcome per target.
 *
 * Idempotency: a deleted-like target (DELETING / DELETED / EXPIRED / AUTO_DELETED)
 * is skipped here — never handed to the per-target teardown — so a repeat request
 * never republishes an AWS delete event or re-invokes a non-AWS destroy. (The
 * pre-skip is essential: the per-target function only treats DELETING/DELETED as
 * already-deleted, so EXPIRED/AUTO_DELETED would otherwise be torn down again.)
 *
 * The per-target teardown is injected, so the fan-out / parent-DELETING /
 * idempotency / failure-isolation logic is unit-testable without EventBridge or a
 * cloud. Parent + target rows are never deleted here.
 */

import type { DeploymentsCompositePort } from "../../control-data/deployments-repository.js";
import {
  type CompositeDeploymentRepositoryDeps,
  getCompositeParent,
  listCompositeTargets,
} from "./composite-repository.js";
import type { TeardownOutcome } from "./delete.js";
import { resolveDeploymentsRepository } from "./shared.js";

export type CompositeTeardownOutcome =
  | "accepted"
  | "already_deleted"
  | "not_dispatchable"
  | "failed";

export interface CompositeTeardownTargetResult {
  readonly targetId: string;
  readonly targetDeploymentId: string;
  readonly outcome: CompositeTeardownOutcome;
}

export interface CompositeTeardownResult {
  readonly parentDeploymentId: string;
  readonly targets: readonly CompositeTeardownTargetResult[];
}

/** Raised when the parent is missing / not composite / owned by another tenant. */
export class CompositeTeardownError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    reason: string,
  ) {
    super(`composite teardown for parent ${parentDeploymentId}: ${reason}`);
    this.name = "CompositeTeardownError";
  }
}

const DELETED_LIKE_STATUSES = new Set(["DELETING", "DELETED", "EXPIRED", "AUTO_DELETED"]);

export interface CompositeTeardownDeps {
  /** Repository deps (injected ddb client + table name) for loads + the DELETING write. */
  readonly repo: CompositeDeploymentRepositoryDeps;
  /** Existing per-target `requestTeardown` operation (#2059). */
  readonly teardownTarget: (targetDeploymentId: string) => Promise<TeardownOutcome>;
  /** Clock for the parent `updatedAt` (epoch ms). */
  readonly now: () => number;
}

/** Map the per-target {@link TeardownOutcome} to a composite outcome. */
function mapOutcome(outcome: TeardownOutcome): CompositeTeardownOutcome {
  switch (outcome.kind) {
    case "accepted":
      return "accepted";
    case "already_deleted":
      return "already_deleted";
    case "race":
      return "not_dispatchable";
    default:
      // not_found / missing_required_fields — a real failure for this target.
      return "failed";
  }
}

/**
 * Conditionally flip the parent to DELETING. A row already in DELETING (repeat
 * request) trips the condition and is a no-op, not an error.
 *
 * [Issue #2441 / Phase B2] `markCompositeParentDeleting` folds the CCF into a
 * `conflict` outcome instead of throwing — discarding it here is the
 * byte-identical no-op the pre-seam CCF-swallow produced.
 */
async function markParentDeleting(
  deps: CompositeTeardownDeps,
  parentDeploymentId: string,
): Promise<void> {
  const repository: DeploymentsCompositePort = await resolveDeploymentsRepository(deps.repo);
  await repository.markCompositeParentDeleting(
    parentDeploymentId,
    new Date(deps.now()).toISOString(),
  );
}

async function teardownOneTarget(
  deps: CompositeTeardownDeps,
  target: { targetId: string; jobId: string; status: string },
): Promise<CompositeTeardownTargetResult> {
  const base = { targetId: target.targetId, targetDeploymentId: target.jobId };

  // Deleted-like targets are never re-invoked (see module docs).
  if (DELETED_LIKE_STATUSES.has(target.status)) {
    return { ...base, outcome: "already_deleted" };
  }

  try {
    const outcome = await deps.teardownTarget(target.jobId);
    return { ...base, outcome: mapOutcome(outcome) };
  } catch (err) {
    console.warn("[composite-teardown] target teardown request failed", {
      targetId: target.targetId,
      // Class name only — never the message, which could carry provider detail.
      reason: err instanceof Error ? err.name : "unknown error",
    });
    return { ...base, outcome: "failed" };
  }
}

/**
 * Request teardown for every eligible target of a composite parent. Sets the
 * parent to DELETING first, then fans out; never resolves final parent deletion.
 */
export async function requestCompositeTeardown(
  deps: CompositeTeardownDeps,
  input: { parentDeploymentId: string; tenantId: string },
): Promise<CompositeTeardownResult> {
  const parent = await getCompositeParent(deps.repo, input.parentDeploymentId);
  if (!parent) {
    throw new CompositeTeardownError(
      input.parentDeploymentId,
      "not found or not a composite parent",
    );
  }
  // Cross-tenant access is hidden as not-found (no existence leak).
  if (parent.tenantId !== input.tenantId) {
    throw new CompositeTeardownError(
      input.parentDeploymentId,
      "not found or not a composite parent",
    );
  }

  await markParentDeleting(deps, input.parentDeploymentId);

  const targets = [...(await listCompositeTargets(deps.repo, input.parentDeploymentId))].sort(
    (a, b) => a.targetOrdinal - b.targetOrdinal,
  );

  const results: CompositeTeardownTargetResult[] = [];
  for (const target of targets) {
    results.push(await teardownOneTarget(deps, target));
  }
  return { parentDeploymentId: input.parentDeploymentId, targets: results };
}
