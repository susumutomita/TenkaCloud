import type { MutableDeploymentRecord } from "./sql-deployments-core.js";
import {
  DEPLOYMENT_INSERT_SQL,
  DEPLOYMENT_UPDATE_SET,
  deploymentFromPayload,
  deploymentRowParams,
  deploymentUpdateParams,
  isUniqueConstraintViolation,
  type SqlDeploymentsCore,
  statusIn,
} from "./sql-deployments-core.js";
import type {
  BulkDeploymentCreateEntry,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsLifecyclePort,
  DeploymentsRepository,
  SqlStatement,
} from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsLifecyclePort} adapter — create / SFN status writebacks / retry-delete compensations / bulk / schedule,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 */
export class SqlDeploymentsLifecycle implements DeploymentsLifecyclePort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async putDeployment(record: DeploymentRecord): Promise<void> {
    await this.core.putRecord(record);
  }

  async markCreateInProgress(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.core.mutateCreateStatusWrite(jobId, (record) => {
      record.status = "IN_PROGRESS";
      record.updatedAt = at;
    });
  }

  async markCreateSucceeded(
    jobId: string,
    stackId: string,
    stackOutputs: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateCreateStatusWrite(jobId, (record) => {
      record.status = "COMPLETE";
      record.updatedAt = at;
      record.stackId = stackId;
      record.stackOutputs = stackOutputs;
      // [Issue #2946] 最初の到達時だけ書く (`??=`)。read-modify-write なので `payload` から
      // 復元した既存値がそのまま残り、teardown 系の書き込みでも消えない。
      record.completedAt ??= at;
      if (buildId !== undefined) record.buildId = buildId;
    });
  }

  async markCreateFailed(
    jobId: string,
    failureReason: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateCreateStatusWrite(jobId, (record) => {
      record.status = "FAILED";
      record.updatedAt = at;
      record.failureReason = failureReason;
      if (buildId !== undefined) record.buildId = buildId;
    });
  }

  /**
   * [Issue #2441 / Phase B PR-6] DeployDelete SFN `MarkDeleted`. Unlike
   * {@link mutateCreateStatusWrite} (which only touches status/updated_at/payload),
   * this also clears `login_key_hash` — the SQL equivalent of DDB's `REMOVE
   * GSI2PK, GSI2SK` — by deleting `teamLoginKey` from the in-memory record before
   * a full-row rewrite (`DEPLOYMENT_UPDATE_SET`), so a deleted deployment no
   * longer resolves via `listByTeamLoginKey`.
   */
  async markDeleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    const row = await this.core.getDeploymentRow(jobId);
    if (!row) return { outcome: "not_found" };
    const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
    record.status = "DELETED";
    record.updatedAt = at;
    delete (record as Record<string, unknown>).teamLoginKey;
    const result = await this.core.sql.run(
      `UPDATE deployments SET ${DEPLOYMENT_UPDATE_SET} WHERE job_id = ?`,
      [...deploymentUpdateParams(record), jobId],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "not_found" };
  }

  async markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, "PENDING"],
      predicate: (record) => record.tenantId === tenantId && record.status === "PENDING",
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
        record.expiresAt = expiresAt;
      },
      onMiss: "conflict",
    });
  }

  async retryToPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "status = ? AND tenant_id = ?",
      whereParams: ["FAILED", tenantId],
      predicate: (record) => record.status === "FAILED" && record.tenantId === tenantId,
      mutate: (record) => {
        record.status = "PENDING";
        record.updatedAt = at;
        delete record.failureReason;
      },
      onMiss: "conflict",
    });
  }

  async compensateRetryToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "status = ? AND tenant_id = ?",
      whereParams: ["PENDING", tenantId],
      predicate: (record) => record.status === "PENDING" && record.tenantId === tenantId,
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
        record.expiresAt = expiresAt;
      },
      onMiss: "conflict",
    });
  }

  async markDeleting(
    jobId: string,
    tenantId: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    const allowed = ["PENDING", "APPROVAL_PENDING", "IN_PROGRESS", "COMPLETE", "FAILED"];
    return this.core.mutateExisting({
      jobId,
      whereSql: `tenant_id = ? AND status IN (${allowed.map(() => "?").join(", ")})`,
      whereParams: [tenantId, ...allowed],
      predicate: (record) => record.tenantId === tenantId && statusIn(record, allowed),
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
        record.expiresAt = expiresAt;
        // [Issue #3128] Permanent teardown marker, written once — see the
        // DynamoDB adapter for why status cannot carry this.
        record.teardownRequestedAt ??= at;
      },
      onMiss: "conflict",
    });
  }

  async compensateDeleteToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, "DELETING"],
      predicate: (record) => record.tenantId === tenantId && record.status === "DELETING",
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
        record.expiresAt = expiresAt;
      },
      onMiss: "conflict",
    });
  }

  async markApprovalPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, "PENDING"],
      predicate: (record) => record.tenantId === tenantId && record.status === "PENDING",
      mutate: (record) => {
        record.status = "APPROVAL_PENDING";
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "status = ?",
      whereParams: ["DELETING"],
      predicate: (record) => record.status === "DELETING",
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
      },
      onMiss: "conflict",
    });
  }

  async markStuckCreatingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const creatingStatuses = ["PENDING", "IN_PROGRESS"];
    return this.core.mutateExisting({
      jobId,
      whereSql: "status IN (?, ?)",
      whereParams: creatingStatuses,
      predicate: (record) => statusIn(record, creatingStatuses),
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
      },
      onMiss: "conflict",
    });
  }

  async transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[2],
    nextStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[3],
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, currentStatus],
      predicate: (record) => record.tenantId === tenantId && record.status === currentStatus,
      mutate: (record) => {
        record.status = nextStatus;
        record.updatedAt = at;
        if (stackOutputs !== undefined) record.stackOutputs = stackOutputs;
      },
      onMiss: "conflict",
    });
  }

  async compensateBulkTeardown(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, "DELETING"],
      predicate: (record) => record.tenantId === tenantId && record.status === "DELETING",
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = "Failed to publish DeployDeleteRequested event (bulk teardown)";
      },
      onMiss: "conflict",
    });
  }

  async markDeletingForBulk(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const allowed = ["PENDING", "APPROVAL_PENDING", "IN_PROGRESS", "COMPLETE", "FAILED"];
    return this.core.mutateExisting({
      jobId,
      whereSql: `tenant_id = ? AND status IN (${allowed.map(() => "?").join(", ")})`,
      whereParams: [tenantId, ...allowed],
      predicate: (record) => record.tenantId === tenantId && statusIn(record, allowed),
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
        // [Issue #3128] Same permanent teardown marker as `markDeleting`.
        record.teardownRequestedAt ??= at;
      },
      onMiss: "conflict",
    });
  }

  async applySchedulePatch(
    jobId: string,
    tenantId: string,
    patch: DeploymentSchedulePatch,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ?",
      whereParams: [tenantId],
      predicate: (record) => record.tenantId === tenantId,
      mutate: (record) => {
        record.updatedAt = at;
        if (patch.startsAt !== undefined) record.eventStartsAt = patch.startsAt;
        if (patch.endsAt !== undefined) record.eventEndsAt = patch.endsAt;
      },
      onMiss: "not_found",
    });
  }

  async createBulkDeployments(
    tenantId: string,
    entries: readonly BulkDeploymentCreateEntry[],
  ): Promise<DeploymentMutationOutcome> {
    if (entries.length === 0) return { outcome: "updated" };
    for (const entry of entries) {
      if (!entry.replacesJobId) continue;
      const row = await this.core.getDeploymentRow(entry.replacesJobId);
      if (!row || row.tenant_id !== tenantId) return { outcome: "conflict" };
    }
    const statements: SqlStatement[] = [];
    for (const entry of entries) {
      statements.push({ sql: DEPLOYMENT_INSERT_SQL, params: deploymentRowParams(entry.record) });
      if (entry.replacesJobId) {
        statements.push({
          sql: "DELETE FROM deployments WHERE job_id = ? AND tenant_id = ?",
          params: [entry.replacesJobId, tenantId],
        });
      }
    }
    try {
      await this.core.sql.batch(statements);
      return { outcome: "updated" };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  async compensateBulkCreateToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ? AND status = ?",
      whereParams: [tenantId, "PENDING"],
      predicate: (record) => record.tenantId === tenantId && record.status === "PENDING",
      mutate: (record) => {
        record.status = "FAILED";
        record.updatedAt = at;
        record.failureReason = reason;
      },
      onMiss: "conflict",
    });
  }

  async stampEventEndsAt(
    jobId: string,
    tenantId: string,
    endsAt: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      whereSql: "tenant_id = ?",
      whereParams: [tenantId],
      predicate: (record) => record.tenantId === tenantId,
      mutate: (record) => {
        record.eventEndsAt = endsAt;
        record.updatedAt = at;
      },
      onMiss: "not_found",
    });
  }
}
