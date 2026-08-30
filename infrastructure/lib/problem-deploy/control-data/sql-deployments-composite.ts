import type { SqlDeploymentsCore } from "./sql-deployments-core.js";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsCompositePort,
  DeploymentsRepository,
} from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsCompositePort} adapter — composite parent/target persistence, CAS, and composite reconciler scans,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 */
export class SqlDeploymentsComposite implements DeploymentsCompositePort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE parent_deployment_id = ? " +
        "ORDER BY target_ordinal ASC, target_id ASC",
      [parentDeploymentId],
    );
    return this.core.records(rows);
  }

  async forEachCompositeDeployReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE runtime_kind = ? AND status IN (?, ?) ORDER BY job_id ASC",
      ["composite", "PENDING", "IN_PROGRESS"],
    );
    await onPage(this.core.records(rows));
  }

  async forEachCompositeTeardownPendingPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE runtime_kind = ? AND status = ? ORDER BY job_id ASC",
      ["composite", "DELETING"],
    );
    await onPage(this.core.records(rows));
  }

  async failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "status = ?",
      whereParams: ["PENDING"],
      predicate: (record) => record.status === "PENDING",
      mutate: (record) => {
        record.status = "FAILED";
        record.failureReason = reason;
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "runtime_kind = ? AND status <> ?",
      whereParams: ["composite", "DELETING"],
      predicate: (record) =>
        (record as { runtimeKind?: string }).runtimeKind === "composite" &&
        record.status !== "DELETING",
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
        // [Issue #3128] Same permanent teardown marker as the other DELETING
        // transitions — see `domain/deployments.ts` for why status cannot
        // carry this on its own.
        record.teardownRequestedAt ??= at;
      },
      onMiss: "conflict",
    });
  }

  async putCompositeParent(
    record: CompositeParentDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalInsert(record, { probeTenantId: record.tenantId });
  }

  async putCompositeTarget(
    record: CompositeTargetDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalInsert(record, "conflict");
  }

  async casCompositeParentStatus(
    jobId: string,
    previousStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[1],
    nextStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[2],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "status = ? AND runtime_kind = ?",
      whereParams: [previousStatus, "composite"],
      predicate: (record) =>
        record.status === previousStatus &&
        (record as { runtimeKind?: string }).runtimeKind === "composite",
      mutate: (record) => {
        record.status = nextStatus;
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }
}
