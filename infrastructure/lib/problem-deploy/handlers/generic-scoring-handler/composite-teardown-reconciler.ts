/**
 * [Composite Runtime / Issue #2072] Reconcile a composite parent's TEARDOWN
 * completion from its target rows.
 *
 * Teardown is requested by #2071 (`requestCompositeTeardown`), which flips the
 * parent to DELETING and fans the delete out to every target — but it never
 * decides when the parent is actually gone. This module closes that loop:
 *   - it processes ONLY composite parents currently in DELETING,
 *   - reads the targets through the #2061 repository (GSI3),
 *   - and conditionally moves the parent DELETING → DELETED ONLY when every
 *     target is in a deleted-like terminal state.
 *
 * "Deleted-like" here is intentionally narrower than #2071's pre-skip set: a
 * target counts as torn down only when DELETED / EXPIRED / AUTO_DELETED. DELETING
 * (still in flight) and FAILED (teardown error — left for operator inspection)
 * do NOT count, so a stuck or failed target keeps the parent in DELETING rather
 * than being silently reported as deleted.
 *
 * Conservative by construction: a malformed (empty) target set is logged and the
 * parent is left unchanged, never guessed to DELETED; a conditional-write race is
 * a no-op; target rows are never modified; and nothing is ever turned to FAILED
 * here. Deploy-phase aggregation (#2068) is untouched — this is deletion only.
 */

import { type DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { deploymentPk } from "../deploy-handler/composite-deployment.js";
import {
  type CompositeDeploymentRepositoryDeps,
  getCompositeParent,
  listCompositeTargets,
} from "../deploy-handler/composite-repository.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { forEachScanPage } from "../shared/ddb-paginate.js";

/** A target is confirmed torn down only in one of these terminal states. */
const TEARDOWN_COMPLETE_STATUSES: ReadonlySet<string> = new Set([
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

export interface CompositeTeardownReconcileDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly deploymentsTableName: string;
}

export interface CompositeTeardownReconcileResult {
  readonly previousStatus: DeploymentStatus;
  readonly nextStatus: DeploymentStatus;
  readonly changed: boolean;
}

/** Raised when the row is absent or is not a composite parent (worker-internal). */
export class CompositeTeardownNotReconcilableError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    reason: string,
  ) {
    super(`composite parent ${parentDeploymentId} ${reason}`);
    this.name = "CompositeTeardownNotReconcilableError";
  }
}

function repoDeps(deps: CompositeTeardownReconcileDeps): CompositeDeploymentRepositoryDeps {
  return { ddb: deps.ddb, tableName: deps.deploymentsTableName };
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException";
}

/**
 * Finalize one composite parent teardown. Only a DELETING parent whose every
 * target is deleted-like is moved to DELETED; everything else is a no-op. See
 * module docs for the empty-set / race / no-mutation rules.
 */
export async function reconcileCompositeParentTeardown(
  deps: CompositeTeardownReconcileDeps,
  input: { parentDeploymentId: string; nowIso: string },
): Promise<CompositeTeardownReconcileResult> {
  const repo = repoDeps(deps);
  const parent = await getCompositeParent(repo, input.parentDeploymentId);
  if (!parent) {
    throw new CompositeTeardownNotReconcilableError(
      input.parentDeploymentId,
      "not found or not a composite parent",
    );
  }
  const previousStatus = parent.status;

  // Only a parent that is actively being torn down can complete teardown here.
  if (previousStatus !== "DELETING") {
    return { previousStatus, nextStatus: previousStatus, changed: false };
  }

  const targets = await listCompositeTargets(repo, input.parentDeploymentId);
  if (targets.length === 0) {
    // A composite parent with no targets is malformed — never guess DELETED.
    console.warn("[composite-teardown-reconciler] skip: malformed empty target set", {
      parentDeploymentId: input.parentDeploymentId,
    });
    return { previousStatus, nextStatus: previousStatus, changed: false };
  }

  const allDeletedLike = targets.every((target) => TEARDOWN_COMPLETE_STATUSES.has(target.status));
  if (!allDeletedLike) {
    return { previousStatus, nextStatus: previousStatus, changed: false };
  }

  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.deploymentsTableName,
        Key: { PK: deploymentPk(input.parentDeploymentId), SK: "META" },
        UpdateExpression: "SET #s = :next, updatedAt = :now",
        // Only write when the parent is still DELETING AND a composite parent — a
        // concurrent writer makes this a no-op, not an error.
        ConditionExpression: "#s = :prev AND runtimeKind = :composite",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": "DELETED",
          ":prev": "DELETING",
          ":now": input.nowIso,
          ":composite": "composite",
        },
      }),
    );
    return { previousStatus, nextStatus: "DELETED", changed: true };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return { previousStatus, nextStatus: previousStatus, changed: false };
    }
    throw err;
  }
}

/**
 * Scan composite parent rows (only) currently in DELETING and finalize each.
 * Legacy single-provider rows (no `runtimeKind`) and target rows (not
 * `runtimeKind=composite`) are excluded by the filter. Per-parent failures are
 * logged, never thrown, so one bad parent does not stall the tick.
 */
export async function reconcileCompositeParentTeardowns(
  deps: CompositeTeardownReconcileDeps,
  nowIso: string,
): Promise<void> {
  await forEachScanPage(
    deps.ddb,
    {
      TableName: deps.deploymentsTableName,
      FilterExpression: "runtimeKind = :composite AND #s = :deleting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":composite": "composite",
        ":deleting": "DELETING",
      },
      Limit: 200,
    },
    async (page) => {
      await Promise.all(
        page.map((item) => {
          const parentDeploymentId = String((item as { jobId?: unknown }).jobId ?? "");
          if (!parentDeploymentId) return Promise.resolve();
          return reconcileCompositeParentTeardown(deps, { parentDeploymentId, nowIso }).catch(
            (err) => {
              console.warn("[composite-teardown-reconciler] reconcile failed", {
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
