/**
 * [Composite Runtime / Issue #2068] Reconcile a composite parent's deploy-phase
 * status from its target rows.
 *
 * The composite parent coordination row has no execution of its own, so a
 * scheduled tick must derive its status from the targets. This module:
 *   - reads one parent + its targets through the #2061 repository (GSI3),
 *   - applies the pure #2067 `aggregateCompositeDeployStatus` truth table,
 *   - conditionally writes the parent status back ONLY when it changed and the
 *     current row still matches the read value (a write race is a no-op), and
 *   - scans for composite parents and runs the above after the per-target non-AWS
 *     reconciliation, on the existing generic-scoring tick (no new scheduler).
 *
 * Deploy phase only: a malformed / deletion-like target set makes the aggregator
 * throw, which is logged and skipped — the parent is never overwritten with a
 * guessed state. Target rows are never modified, and teardown/deletion is a later
 * issue.
 */

import { type DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { deploymentPk } from "../deploy-handler/composite-deployment.js";
import {
  type CompositeDeploymentRepositoryDeps,
  getCompositeParent,
  listCompositeTargets,
} from "../deploy-handler/composite-repository.js";
import {
  aggregateCompositeDeployStatus,
  CompositeStatusError,
} from "../deploy-handler/composite-status.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { forEachScanPage } from "../shared/ddb-paginate.js";

/** Parents in a non-terminal deploy-phase status are worth re-deriving. */
const PARENT_RECONCILABLE_STATUSES = ["PENDING", "IN_PROGRESS"] as const;

export interface CompositeParentReconcileDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly deploymentsTableName: string;
}

export interface CompositeParentReconcileResult {
  readonly previousStatus: DeploymentStatus;
  readonly nextStatus: DeploymentStatus;
  readonly changed: boolean;
}

/** Raised when the row is absent or is not a composite parent (worker-internal). */
export class CompositeParentNotReconcilableError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    reason: string,
  ) {
    super(`composite parent ${parentDeploymentId} ${reason}`);
    this.name = "CompositeParentNotReconcilableError";
  }
}

function repoDeps(deps: CompositeParentReconcileDeps): CompositeDeploymentRepositoryDeps {
  return { ddb: deps.ddb, tableName: deps.deploymentsTableName };
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException";
}

/**
 * Re-derive one composite parent's deploy status from its targets and write it
 * back if changed. See module docs for the skip / race / no-mutation rules.
 */
export async function reconcileCompositeParentDeployStatus(
  deps: CompositeParentReconcileDeps,
  input: { parentDeploymentId: string; nowIso: string },
): Promise<CompositeParentReconcileResult> {
  const repo = repoDeps(deps);
  const parent = await getCompositeParent(repo, input.parentDeploymentId);
  if (!parent) {
    throw new CompositeParentNotReconcilableError(
      input.parentDeploymentId,
      "not found or not a composite parent",
    );
  }
  const previousStatus = parent.status;

  const targets = await listCompositeTargets(repo, input.parentDeploymentId);
  const orderedStatuses = [...targets]
    .sort((a, b) => a.targetOrdinal - b.targetOrdinal)
    .map((target) => target.status);

  let nextStatus: DeploymentStatus;
  try {
    nextStatus = aggregateCompositeDeployStatus(orderedStatuses);
  } catch (err) {
    // Malformed / empty / deletion-like target set — skip, never guess.
    if (err instanceof CompositeStatusError) {
      console.warn("[composite-reconciler] skip: cannot aggregate parent status", {
        parentDeploymentId: input.parentDeploymentId,
        reason: err.message,
      });
      return { previousStatus, nextStatus: previousStatus, changed: false };
    }
    throw err;
  }

  if (nextStatus === previousStatus) {
    return { previousStatus, nextStatus, changed: false };
  }

  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.deploymentsTableName,
        Key: { PK: deploymentPk(input.parentDeploymentId), SK: "META" },
        UpdateExpression: "SET #s = :next, updatedAt = :now",
        // Only write when the parent is still what we read AND is a composite
        // parent — a concurrent writer makes this a no-op, not an error.
        ConditionExpression: "#s = :prev AND runtimeKind = :composite",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": nextStatus,
          ":prev": previousStatus,
          ":now": input.nowIso,
          ":composite": "composite",
        },
      }),
    );
    return { previousStatus, nextStatus, changed: true };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { previousStatus, nextStatus, changed: false };
    }
    throw err;
  }
}

/**
 * Scan composite parent rows (only) in a non-terminal deploy status and reconcile
 * each. Legacy single-provider rows (no `runtimeKind`) and target rows (which are
 * not `runtimeKind=composite`) are excluded by the filter. Per-parent failures
 * are logged, never thrown, so one bad parent does not stall the tick.
 */
export async function reconcileCompositeParents(
  deps: CompositeParentReconcileDeps,
  nowIso: string,
): Promise<void> {
  await forEachScanPage(
    deps.ddb,
    {
      TableName: deps.deploymentsTableName,
      FilterExpression: "runtimeKind = :composite AND #s IN (:p, :i)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":composite": "composite",
        ":p": PARENT_RECONCILABLE_STATUSES[0],
        ":i": PARENT_RECONCILABLE_STATUSES[1],
      },
      Limit: 200,
    },
    async (page) => {
      await Promise.all(
        page.map((item) => {
          const parentDeploymentId = String((item as { jobId?: unknown }).jobId ?? "");
          if (!parentDeploymentId) return Promise.resolve();
          return reconcileCompositeParentDeployStatus(deps, { parentDeploymentId, nowIso }).catch(
            (err) => {
              console.warn("[composite-reconciler] reconcile failed", {
                parentDeploymentId,
                message: err instanceof Error ? err.message : String(err),
              });
            },
          );
        }),
      );
    },
  );
}

/**
 * Run the scheduled deploy-status maintenance: the existing per-target non-AWS
 * reconciliation FIRST, then the composite parent reconciliation — so a parent is
 * aggregated from already-refreshed target statuses. Injecting the per-target
 * step keeps the ordering testable.
 */
export async function reconcileDeployStatusMaintenance(
  deps: CompositeParentReconcileDeps,
  nowIso: string,
  reconcilePerTarget: () => Promise<void>,
): Promise<void> {
  await reconcilePerTarget();
  await reconcileCompositeParents(deps, nowIso);
}
