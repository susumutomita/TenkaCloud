import { decodeCursor, encodeCursor, type SqlDeploymentsCore } from "./sql-deployments-core.js";
import { hashLoginKey } from "./sql-teams-repository.js";
import type { DeploymentRecord, DeploymentsPage, DeploymentsQueryPort } from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsQueryPort} adapter — point reads, GSI/tenant listings, and reconciler page scans,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 */
export class SqlDeploymentsQuery implements DeploymentsQueryPort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  /** Point read — implemented on the core engine because the write-side conflict probes reuse it. */
  readonly getDeployment: DeploymentsQueryPort["getDeployment"] = (...args) =>
    this.core.getDeployment(...args);

  async queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined> {
    return this.core.getDeployment(jobId);
  }

  async listByTenantPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DeploymentsPage> {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const rows = after
      ? await this.core.selectRows(
          "SELECT payload, created_at, job_id FROM deployments WHERE list_tenant_id = ? " +
            "AND (created_at < ? OR (created_at = ? AND job_id < ?)) " +
            "ORDER BY created_at DESC, job_id DESC LIMIT ?",
          [tenantId, after.createdAt, after.createdAt, after.jobId, opts.limit + 1],
        )
      : await this.core.selectRows(
          "SELECT payload, created_at, job_id FROM deployments WHERE list_tenant_id = ? " +
            "ORDER BY created_at DESC, job_id DESC LIMIT ?",
          [tenantId, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: this.core.records(page),
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: String(last.created_at), jobId: String(last.job_id) })
          : undefined,
    };
  }

  async countActiveByTenant(
    tenantId: string,
    activeStatuses: readonly string[],
    _opts?: { readonly stopAtCount?: number },
  ): Promise<number> {
    if (activeStatuses.length === 0) return 0;
    const placeholders = activeStatuses.map(() => "?").join(", ");
    const row = await this.core.sql.get(
      `SELECT COUNT(*) AS cnt FROM deployments WHERE list_tenant_id = ? AND status IN (${placeholders})`,
      [tenantId, ...activeStatuses],
    );
    return Number(row?.cnt ?? 0);
  }

  /**
   * [Issue #2946] `completedAt` は `payload` (このバックエンドの record of truth) から読む。
   *
   * 専用の列と index を足すほうが速いが、schema は `CREATE TABLE IF NOT EXISTS` だけで
   * 適用され ALTER の経路が無いため、列を増やすと **既存の Turso データベースに列が生えない
   * まま INSERT の列数だけ増えて実行時に壊れる**。移行機構の導入は別作業なので、ここでは
   * payload を読む。呼び出し元は operator の低頻度ダッシュボードで、ホットパスではない。
   */
  async countEverCompletedByTenant(tenantId: string): Promise<number> {
    const row = await this.core.sql.get(
      "SELECT COUNT(*) AS cnt FROM deployments WHERE list_tenant_id = ? " +
        "AND json_extract(payload, '$.completedAt') IS NOT NULL",
      [tenantId],
    );
    return Number(row?.cnt ?? 0);
  }

  async listByTenantAndEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId],
    );
    return this.core.records(rows);
  }

  async listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]> {
    const rows = await this.core.selectRows(
      "SELECT job_id FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId],
    );
    return rows.map((row) => String(row.job_id));
  }

  async listReconcilerRowsByEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly Pick<DeploymentRecord, "jobId" | "status" | "updatedAt">[]> {
    const rows = await this.core.selectRows(
      "SELECT job_id, status, updated_at FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId],
    );
    return rows.map((row) => ({
      jobId: String(row.job_id),
      status: row.status as DeploymentRecord["status"],
      updatedAt: String(row.updated_at),
    }));
  }

  async listByEventTeamProblem(
    tenantId: string,
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "AND team_id = ? AND problem_id = ? ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId, teamId, problemId],
    );
    return this.core.records(rows);
  }

  async findByNamePrefix(
    tenantId: string,
    namePrefix: string,
  ): Promise<readonly Pick<DeploymentRecord, "namePrefix" | "jobId" | "status">[]> {
    const rows = await this.core.selectRows(
      "SELECT job_id, name_prefix, status FROM deployments WHERE list_tenant_id = ? AND name_prefix = ? " +
        "ORDER BY created_at ASC, job_id ASC",
      [tenantId, namePrefix],
    );
    return rows.map((row) => ({
      namePrefix: String(row.name_prefix),
      jobId: String(row.job_id),
      status: row.status as DeploymentRecord["status"],
    }));
  }

  async listDeploymentSummariesByTenant(
    tenantId: string,
  ): Promise<
    readonly Pick<
      DeploymentRecord,
      "jobId" | "teamId" | "eventId" | "displayTeamName" | "teamName" | "problemId" | "status"
    >[]
  > {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? ORDER BY created_at ASC, job_id ASC",
      [tenantId],
    );
    return this.core.records(rows).map((record) => ({
      jobId: record.jobId,
      teamId: record.teamId,
      eventId: record.eventId,
      displayTeamName: record.displayTeamName,
      teamName: record.teamName,
      problemId: record.problemId,
      status: record.status,
    }));
  }

  async listByTeamLoginKey(teamLoginKey: string): Promise<readonly DeploymentRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE login_key_hash = ? ORDER BY created_at ASC, job_id ASC",
      [hashLoginKey(teamLoginKey)],
    );
    return this.core.records(rows, teamLoginKey);
  }

  async forEachCompleteDeploymentPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
    onCoordinationRecoveryPage?: (scopes: readonly CoordinationStateScope[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE status = ? ORDER BY job_id ASC",
      ["COMPLETE"],
    );
    await onPage(this.core.records(rows));
    if (onCoordinationRecoveryPage) {
      const pending = await this.core.selectRows(
        `SELECT tenant_id, event_id, problem_id, run_id FROM coordination_state_scoped
         WHERE ${HAS_PENDING_COORDINATION_SCORES_SQL}
         UNION SELECT tenant_id, event_id, problem_id, run_id FROM coordination_run
         WHERE pending_initialization = 1`,
        [],
      );
      await onCoordinationRecoveryPage(
        pending.map((row) => ({
          tenantId: String(row.tenant_id),
          eventId: String(row.event_id),
          problemId: String(row.problem_id),
          runId: String(row.run_id),
        })),
      );
    }
  }

  async forEachRuntimeReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployments WHERE runtime_provider IS NOT NULL " +
        "AND status IN (?, ?, ?, ?) ORDER BY job_id ASC",
      ["PENDING", "IN_PROGRESS", "COMPLETE", "DELETING"],
    );
    await onPage(this.core.records(rows));
  }
}

import type { CoordinationStateScope } from "./domain/coordination-scope.js";
import { HAS_PENDING_COORDINATION_SCORES_SQL } from "./sql-deployments-coordination.js";
