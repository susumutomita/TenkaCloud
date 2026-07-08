import { ulid } from "ulid";
import { compositeTargetGsi3Sk } from "../handlers/deploy-handler/composite-deployment.js";
import { buildScoreEventRecord } from "../handlers/shared/score-event.js";
import { hashLoginKey } from "./sql-teams-repository.js";
import type {
  BulkDeploymentCreateEntry,
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  CoordinationStateRecord,
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsPage,
  DeploymentsRepository,
  InboxEventRecord,
  ScoreEventRecord,
  SqlExecutor,
  SqlParam,
  SqlRow,
  SqlStatement,
} from "./types.js";

type DeploymentWriteRecord =
  | DeploymentRecord
  | CompositeParentDeploymentRecord
  | CompositeTargetDeploymentRecord;

type MutableDeploymentRecord = Record<string, unknown> & DeploymentRecord;

interface DeploymentsKeysetCursor {
  readonly createdAt: string;
  readonly jobId: string;
}

const SCORE_EVENT_SK_PREFIX = "EVENT#" as const;
const INBOX_EVENT_SK_PREFIX = "INBOX#" as const;

/**
 * [Issue #2441 / Phase B4] SQLite schema for the Deployments aggregate.
 *
 * `payload` is the record of truth, while the denormalized columns model the
 * DynamoDB access paths that need indexes. `list_tenant_id` deliberately stays
 * sparse: composite parent/target rows carry `tenant_id` for conditional writes
 * and conflict probes, but do not participate in the tenant listing GSI.
 *
 * SQL scan methods use indexed/filtered queries and invoke `onPage` once with
 * the full row set. That is allowed by the B3 contract: page boundaries are a
 * backend detail, and callers only require that each matching row appears in
 * exactly one callback invocation.
 */
export const DEPLOYMENTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS deployments (
  job_id               TEXT PRIMARY KEY,
  tenant_id            TEXT,
  list_tenant_id       TEXT,
  status               TEXT,
  created_at           TEXT,
  updated_at           TEXT,
  expires_at           INTEGER NOT NULL DEFAULT 0,
  login_key_hash       TEXT,
  parent_deployment_id TEXT,
  target_ordinal       INTEGER,
  target_id            TEXT,
  runtime_kind         TEXT,
  runtime_provider     TEXT,
  event_id             TEXT,
  team_id              TEXT,
  problem_id           TEXT,
  name_prefix          TEXT,
  score                INTEGER,
  payload              TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_tenant_created
  ON deployments (list_tenant_id, created_at DESC, job_id DESC)
  WHERE list_tenant_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_tenant_event
  ON deployments (list_tenant_id, event_id, created_at, job_id)
  WHERE list_tenant_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_login_key_hash
  ON deployments (login_key_hash, created_at, job_id)
  WHERE login_key_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_parent_deployment
  ON deployments (parent_deployment_id, target_ordinal, target_id)
  WHERE parent_deployment_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_status_event
  ON deployments (status, event_id, job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_runtime_kind_status
  ON deployments (runtime_kind, status, job_id)
  WHERE runtime_kind IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_runtime_provider_status
  ON deployments (runtime_provider, status, job_id)
  WHERE runtime_provider IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS deployment_score_events (
  job_id      TEXT    NOT NULL,
  sk          TEXT    NOT NULL,
  record_type TEXT    NOT NULL,
  occurred_at TEXT,
  expires_at  INTEGER NOT NULL DEFAULT 0,
  payload     TEXT    NOT NULL,
  PRIMARY KEY (job_id, sk)
)`,
  `CREATE INDEX IF NOT EXISTS idx_deployment_score_events_job_type_sk
  ON deployment_score_events (job_id, record_type, sk DESC)`,
  `CREATE TABLE IF NOT EXISTS coordination_state (
  tenant_id  TEXT    NOT NULL,
  event_id   TEXT    NOT NULL,
  state      TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const DEPLOYMENTS_SCHEMA_SQL = `${DEPLOYMENTS_SCHEMA_STATEMENTS.join(";\n")};`;

const DEPLOYMENT_COLUMNS =
  "(job_id, tenant_id, list_tenant_id, status, created_at, updated_at, expires_at, " +
  "login_key_hash, parent_deployment_id, target_ordinal, target_id, runtime_kind, " +
  "runtime_provider, event_id, team_id, problem_id, name_prefix, score, payload)";

const DEPLOYMENT_INSERT_SQL =
  `INSERT INTO deployments ${DEPLOYMENT_COLUMNS} ` +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const DEPLOYMENT_UPDATE_SET =
  "tenant_id = ?, list_tenant_id = ?, status = ?, created_at = ?, updated_at = ?, " +
  "expires_at = ?, login_key_hash = ?, parent_deployment_id = ?, target_ordinal = ?, " +
  "target_id = ?, runtime_kind = ?, runtime_provider = ?, event_id = ?, team_id = ?, " +
  "problem_id = ?, name_prefix = ?, score = ?, payload = ?";

function encodeCursor(cursor: DeploymentsKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): DeploymentsKeysetCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { createdAt, jobId } = parsed as Partial<DeploymentsKeysetCursor>;
  if (typeof createdAt !== "string" || typeof jobId !== "string") return undefined;
  return { createdAt, jobId };
}

function isCompositeParentRecord(
  record: DeploymentWriteRecord,
): record is CompositeParentDeploymentRecord {
  return (record as { runtimeKind?: unknown }).runtimeKind === "composite";
}

function isCompositeTargetRecord(
  record: DeploymentWriteRecord,
): record is CompositeTargetDeploymentRecord {
  return typeof (record as { parentDeploymentId?: unknown }).parentDeploymentId === "string";
}

function normalizeJsonValue(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = normalizeJsonValue(entry);
  }
  return out;
}

function payloadWithoutLoginKey(record: DeploymentWriteRecord): string {
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = record as Record<string, unknown>;
  return JSON.stringify(normalizeJsonValue(safeRecord));
}

function deploymentFromPayload(payload: unknown, restoreLoginKey?: string): DeploymentRecord {
  const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
  if (Array.isArray(parsed.solvedFlagIds)) {
    parsed.solvedFlagIds = new Set(parsed.solvedFlagIds);
  }
  if (restoreLoginKey) parsed.teamLoginKey = restoreLoginKey;
  return parsed as DeploymentRecord;
}

function scoreEventFromPayload(payload: unknown): ScoreEventRecord {
  return JSON.parse(String(payload)) as ScoreEventRecord;
}

function inboxEventFromPayload(payload: unknown): InboxEventRecord {
  return JSON.parse(String(payload)) as InboxEventRecord;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function deploymentRowParams(record: DeploymentWriteRecord): SqlParam[] {
  const normalTenantId =
    !isCompositeParentRecord(record) && !isCompositeTargetRecord(record) ? record.tenantId : null;
  const loginKeyHash =
    normalTenantId && (record as { teamLoginKey?: string }).teamLoginKey
      ? hashLoginKey((record as { teamLoginKey: string }).teamLoginKey)
      : null;
  return [
    record.jobId,
    record.tenantId,
    normalTenantId,
    optionalString((record as { status?: unknown }).status),
    optionalString((record as { createdAt?: unknown }).createdAt),
    optionalString((record as { updatedAt?: unknown }).updatedAt),
    Number((record as { expiresAt?: unknown }).expiresAt ?? 0),
    loginKeyHash,
    optionalString((record as { parentDeploymentId?: unknown }).parentDeploymentId),
    optionalNumber((record as { targetOrdinal?: unknown }).targetOrdinal),
    optionalString((record as { targetId?: unknown }).targetId),
    optionalString((record as { runtimeKind?: unknown }).runtimeKind),
    optionalString((record as { runtimeProvider?: unknown }).runtimeProvider),
    optionalString((record as { eventId?: unknown }).eventId),
    optionalString((record as { teamId?: unknown }).teamId),
    optionalString((record as { problemId?: unknown }).problemId),
    optionalString((record as { namePrefix?: unknown }).namePrefix),
    optionalNumber((record as { score?: unknown }).score),
    payloadWithoutLoginKey(record),
  ];
}

function deploymentUpdateParams(record: DeploymentWriteRecord): SqlParam[] {
  return deploymentRowParams(record).slice(1);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJsonValue(left)) === JSON.stringify(normalizeJsonValue(right));
}

function statusIn(record: DeploymentRecord, statuses: readonly string[]): boolean {
  return statuses.includes(String(record.status));
}

function getSolvedFlagSet(record: MutableDeploymentRecord): Set<string> {
  const current = record.solvedFlagIds;
  if (current instanceof Set) return new Set([...current].map(String));
  if (Array.isArray(current)) return new Set(current.map(String));
  return new Set();
}

function ensureNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown };
  if (
    [code, extendedCode].some(
      (value) => value === "SQLITE_CONSTRAINT_PRIMARYKEY" || value === "SQLITE_CONSTRAINT_UNIQUE",
    )
  ) {
    return true;
  }
  return err.message.includes("UNIQUE constraint failed");
}

export class SqlDeploymentsRepository implements DeploymentsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private async getDeploymentRow(jobId: string): Promise<SqlRow | undefined> {
    return this.sql.get("SELECT * FROM deployments WHERE job_id = ?", [jobId]);
  }

  private async putRecord(record: DeploymentWriteRecord): Promise<void> {
    await this.sql.run(
      `${DEPLOYMENT_INSERT_SQL} ON CONFLICT(job_id) DO UPDATE SET ${DEPLOYMENT_UPDATE_SET}`,
      [...deploymentRowParams(record), ...deploymentUpdateParams(record)],
    );
  }

  private async probeConflict(tenantId: string, jobId: string): Promise<DeploymentMutationOutcome> {
    const record = await this.getDeployment(jobId);
    if (!record || record.tenantId !== tenantId) return { outcome: "not_found" };
    return { outcome: "conflict", record };
  }

  private async handleMiss(
    jobId: string,
    onMiss: "conflict" | "not_found" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    if (onMiss === "conflict") return { outcome: "conflict" };
    if (onMiss === "not_found") return { outcome: "not_found" };
    return this.probeConflict(onMiss.probeTenantId, jobId);
  }

  private async mutateExisting(args: {
    readonly jobId: string;
    readonly whereSql?: string;
    readonly whereParams?: readonly SqlParam[];
    readonly predicate: (record: DeploymentRecord, row: SqlRow) => boolean;
    readonly mutate: (record: MutableDeploymentRecord) => void;
    readonly onMiss: "conflict" | "not_found" | { readonly probeTenantId: string };
    readonly withPostImage?: boolean;
  }): Promise<DeploymentMutationOutcome> {
    const row = await this.getDeploymentRow(args.jobId);
    if (!row) return this.handleMiss(args.jobId, args.onMiss);
    const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
    if (!args.predicate(record, row)) return this.handleMiss(args.jobId, args.onMiss);
    args.mutate(record);
    const params = [...deploymentUpdateParams(record), args.jobId, ...(args.whereParams ?? [])];
    const where = args.whereSql ? ` AND (${args.whereSql})` : "";
    if (args.withPostImage) {
      const rows = await this.sql.all(
        `UPDATE deployments SET ${DEPLOYMENT_UPDATE_SET} WHERE job_id = ?${where} RETURNING payload`,
        params,
      );
      const updated = rows[0];
      if (!updated) return this.handleMiss(args.jobId, args.onMiss);
      return {
        outcome: "updated",
        record: deploymentFromPayload(updated.payload),
      };
    }
    const result = await this.sql.run(
      `UPDATE deployments SET ${DEPLOYMENT_UPDATE_SET} WHERE job_id = ?${where}`,
      params,
    );
    if (Number(result.changes) === 0) return this.handleMiss(args.jobId, args.onMiss);
    return { outcome: "updated" };
  }

  private async mutateCreateStatusWrite(
    jobId: string,
    mutate: (record: MutableDeploymentRecord) => void,
  ): Promise<DeploymentMutationOutcome> {
    const row = await this.getDeploymentRow(jobId);
    if (!row) return { outcome: "not_found" };
    const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
    mutate(record);
    const result = await this.sql.run(
      "UPDATE deployments SET status = ?, updated_at = ?, payload = ? WHERE job_id = ?",
      [
        optionalString(record.status),
        optionalString(record.updatedAt),
        payloadWithoutLoginKey(record),
        jobId,
      ],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "not_found" };
  }

  private async conditionalInsert(
    record: DeploymentWriteRecord,
    onConflict: "conflict" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.sql.run(DEPLOYMENT_INSERT_SQL, deploymentRowParams(record));
      return { outcome: "updated", record: record as DeploymentRecord };
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      if (onConflict === "conflict") return { outcome: "conflict" };
      return this.probeConflict(onConflict.probeTenantId, record.jobId);
    }
  }

  private selectRows(sql: string, params: readonly SqlParam[] = []): Promise<readonly SqlRow[]> {
    return Promise.resolve(this.sql.all(sql, params));
  }

  private records(rows: readonly SqlRow[], restoreLoginKey?: string): readonly DeploymentRecord[] {
    return rows.map((row) => deploymentFromPayload(row.payload, restoreLoginKey));
  }

  async getDeployment(jobId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.sql.get("SELECT payload FROM deployments WHERE job_id = ?", [jobId]);
    return row ? deploymentFromPayload(row.payload) : undefined;
  }

  async queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined> {
    return this.getDeployment(jobId);
  }

  async listByTenantPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DeploymentsPage> {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const rows = after
      ? await this.selectRows(
          "SELECT payload, created_at, job_id FROM deployments WHERE list_tenant_id = ? " +
            "AND (created_at < ? OR (created_at = ? AND job_id < ?)) " +
            "ORDER BY created_at DESC, job_id DESC LIMIT ?",
          [tenantId, after.createdAt, after.createdAt, after.jobId, opts.limit + 1],
        )
      : await this.selectRows(
          "SELECT payload, created_at, job_id FROM deployments WHERE list_tenant_id = ? " +
            "ORDER BY created_at DESC, job_id DESC LIMIT ?",
          [tenantId, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: this.records(page),
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
    const row = await this.sql.get(
      `SELECT COUNT(*) AS cnt FROM deployments WHERE list_tenant_id = ? AND status IN (${placeholders})`,
      [tenantId, ...activeStatuses],
    );
    return Number(row?.cnt ?? 0);
  }

  async listByTenantAndEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId],
    );
    return this.records(rows);
  }

  async listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]> {
    const rows = await this.selectRows(
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
    const rows = await this.selectRows(
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
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? AND event_id = ? " +
        "AND team_id = ? AND problem_id = ? ORDER BY created_at ASC, job_id ASC",
      [tenantId, eventId, teamId, problemId],
    );
    return this.records(rows);
  }

  async findByNamePrefix(
    tenantId: string,
    namePrefix: string,
  ): Promise<readonly Pick<DeploymentRecord, "namePrefix" | "jobId" | "status">[]> {
    const rows = await this.selectRows(
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
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE list_tenant_id = ? ORDER BY created_at ASC, job_id ASC",
      [tenantId],
    );
    return this.records(rows).map((record) => ({
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
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE login_key_hash = ? ORDER BY created_at ASC, job_id ASC",
      [hashLoginKey(teamLoginKey)],
    );
    return this.records(rows, teamLoginKey);
  }

  async listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE parent_deployment_id = ? " +
        "ORDER BY target_ordinal ASC, target_id ASC",
      [parentDeploymentId],
    );
    return this.records(rows);
  }

  async listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]> {
    if (opts.maxPages !== undefined && opts.maxPages <= 0) return [];
    const limit = opts.maxPages === undefined ? undefined : opts.pageSize * opts.maxPages;
    const rows =
      limit === undefined
        ? await this.selectRows(
            "SELECT payload FROM deployment_score_events WHERE job_id = ? AND record_type = ? " +
              "ORDER BY sk DESC",
            [jobId, "score"],
          )
        : await this.selectRows(
            "SELECT payload FROM deployment_score_events WHERE job_id = ? AND record_type = ? " +
              "ORDER BY sk DESC LIMIT ?",
            [jobId, "score", limit],
          );
    return rows.map((row) => scoreEventFromPayload(row.payload));
  }

  async listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployment_score_events WHERE job_id = ? AND sk BETWEEN ? AND ? " +
        "ORDER BY sk DESC",
      [jobId, fromSk, toSk],
    );
    return rows.map((row) => scoreEventFromPayload(row.payload));
  }

  async listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployment_score_events WHERE job_id = ? AND sk BETWEEN ? AND ? " +
        "ORDER BY sk DESC",
      [jobId, fromSk, toSk],
    );
    return rows.map((row) => inboxEventFromPayload(row.payload));
  }

  async readCoordinationState(
    tenantId: string,
    eventId: string,
  ): Promise<CoordinationStateRecord | undefined> {
    const row = await this.sql.get(
      "SELECT state, version FROM coordination_state WHERE tenant_id = ? AND event_id = ?",
      [tenantId, eventId],
    );
    if (!row) return undefined;
    return { state: JSON.parse(String(row.state)), version: Number(row.version ?? 0) };
  }

  async forEachCompleteDeploymentPage(
    eventId: string | undefined,
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = eventId
      ? await this.selectRows(
          "SELECT payload FROM deployments WHERE status = ? AND event_id = ? ORDER BY job_id ASC",
          ["COMPLETE", eventId],
        )
      : await this.selectRows(
          "SELECT payload FROM deployments WHERE status = ? ORDER BY job_id ASC",
          ["COMPLETE"],
        );
    await onPage(this.records(rows));
  }

  async forEachCompositeDeployReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE runtime_kind = ? AND status IN (?, ?) ORDER BY job_id ASC",
      ["composite", "PENDING", "IN_PROGRESS"],
    );
    await onPage(this.records(rows));
  }

  async forEachCompositeTeardownPendingPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE runtime_kind = ? AND status = ? ORDER BY job_id ASC",
      ["composite", "DELETING"],
    );
    await onPage(this.records(rows));
  }

  async forEachRuntimeReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const rows = await this.selectRows(
      "SELECT payload FROM deployments WHERE runtime_provider IS NOT NULL " +
        "AND status IN (?, ?, ?, ?) ORDER BY job_id ASC",
      ["PENDING", "IN_PROGRESS", "COMPLETE", "DELETING"],
    );
    await onPage(this.records(rows));
  }

  async forEachRuntimeScoreFeedPage(
    eventId: string,
    onPage: (
      items: readonly Pick<DeploymentRecord, "eventId" | "teamId" | "problemId" | "score">[],
    ) => Promise<void>,
  ): Promise<void> {
    const rows = await this.selectRows(
      "SELECT event_id, team_id, problem_id, score FROM deployments WHERE status = ? " +
        "AND event_id = ? AND team_id IS NOT NULL AND score IS NOT NULL ORDER BY job_id ASC",
      ["COMPLETE", eventId],
    );
    await onPage(
      rows.map((row) => ({
        eventId: row.event_id as string | undefined,
        teamId: row.team_id as string | undefined,
        problemId: String(row.problem_id),
        score: Number(row.score),
      })),
    );
  }

  async putDeployment(record: DeploymentRecord): Promise<void> {
    await this.putRecord(record);
  }

  async markCreateInProgress(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mutateCreateStatusWrite(jobId, (record) => {
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
    return this.mutateCreateStatusWrite(jobId, (record) => {
      record.status = "COMPLETE";
      record.updatedAt = at;
      record.stackId = stackId;
      record.stackOutputs = stackOutputs;
      if (buildId !== undefined) record.buildId = buildId;
    });
  }

  async markCreateFailed(
    jobId: string,
    failureReason: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateCreateStatusWrite(jobId, (record) => {
      record.status = "FAILED";
      record.updatedAt = at;
      record.failureReason = failureReason;
      if (buildId !== undefined) record.buildId = buildId;
    });
  }

  async markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
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
    return this.mutateExisting({
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
    return this.mutateExisting({
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
    return this.mutateExisting({
      jobId,
      whereSql: `tenant_id = ? AND status IN (${allowed.map(() => "?").join(", ")})`,
      whereParams: [tenantId, ...allowed],
      predicate: (record) => record.tenantId === tenantId && statusIn(record, allowed),
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
        record.expiresAt = expiresAt;
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
    return this.mutateExisting({
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
    return this.mutateExisting({
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

  async failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
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
    return this.mutateExisting({
      jobId,
      whereSql: "runtime_kind = ? AND status <> ?",
      whereParams: ["composite", "DELETING"],
      predicate: (record) =>
        (record as { runtimeKind?: string }).runtimeKind === "composite" &&
        record.status !== "DELETING",
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async putCompositeParent(
    record: CompositeParentDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalInsert(record, { probeTenantId: record.tenantId });
  }

  async putCompositeTarget(
    record: CompositeTargetDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalInsert(record, "conflict");
  }

  async applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) => !getSolvedFlagSet(record as MutableDeploymentRecord).has(flagId),
      mutate: (record) => {
        record.score = ensureNumber(record.score) + points;
        record.solvedFlagIds = new Set([...getSolvedFlagSet(record), flagId]);
        record.lastScoredAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) => !getSolvedFlagSet(record as MutableDeploymentRecord).has(flagId),
      mutate: (record) => {
        record.wrongAnswerCount = ensureNumber(record.wrongAnswerCount) + 1;
        record.score = ensureNumber(record.score) - penalty;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) => record.flagSubmitted !== true,
      mutate: (record) => {
        record.wrongAnswerCount = ensureNumber(record.wrongAnswerCount) + 1;
        record.score = ensureNumber(record.score) - penalty;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) => record.flagSubmitted !== true,
      mutate: (record) => {
        record.score = ensureNumber(record.score) + points;
        record.flagSubmitted = true;
        record.lastScoredAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyHintPenalty(
    jobId: string,
    hint: Parameters<DeploymentsRepository["applyHintPenalty"]>[1],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) =>
        !(record.hintsRevealed ?? []).some((entry) => sameJsonValue(entry, hint)),
      mutate: (record) => {
        record.hintsRevealed = [...(record.hintsRevealed ?? []), hint];
        record.updatedAt = at;
        record.score = ensureNumber(record.score) - Number(hint.penaltyApplied ?? 0);
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        record.displayTeamName = name;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        if (result.scoreDelta !== 0) record.score = ensureNumber(record.score) + result.scoreDelta;
        record.lastScoredAt = at;
        record.updatedAt = at;
        if (result.lastResult) record.lastResult = result.lastResult;
        if (result.endpointsHealthJson !== undefined)
          record.endpointsHealth = result.endpointsHealthJson;
        if (result.attackProbesJson !== undefined) record.attackProbes = result.attackProbesJson;
        if (result.postureJson !== undefined) record.posture = result.postureJson;
        if (result.platform !== undefined) record.platform = result.platform;
        if (result.newState !== undefined) record.scoringState = JSON.stringify(result.newState);
      },
      onMiss: "conflict",
    });
  }

  async casCompositeParentStatus(
    jobId: string,
    previousStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[1],
    nextStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[2],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
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

  async latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: (record) => record.gateCompletedAt === undefined,
      mutate: (record) => {
        record.gateCompletedAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const row = await this.getDeploymentRow(parent.jobId);
    if (!row) return { outcome: "conflict" };
    const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
    if (record.gateBonusAwardedAt !== undefined) return { outcome: "conflict" };
    record.score = ensureNumber(record.score) + bonus;
    record.gateBonusAwardedAt = at;
    record.updatedAt = at;
    const scoreEvent = buildScoreEventRecord(parent, "gate-bonus", bonus, at);
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE deployments SET ${DEPLOYMENT_UPDATE_SET} WHERE job_id = ?`,
        params: [...deploymentUpdateParams(record), parent.jobId],
      },
      {
        sql:
          "INSERT INTO deployment_score_events " +
          "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
        params: [
          parent.jobId,
          `${SCORE_EVENT_SK_PREFIX}${at}#${ulid()}`,
          "score",
          at,
          Number(parent.expiresAt ?? 0),
          JSON.stringify(normalizeJsonValue(scoreEvent)),
        ],
      },
    ];
    try {
      await this.sql.batch(statements);
      return { outcome: "updated" };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  async setScoringState(
    jobId: string,
    stateJson: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        record.scoringState = stateJson;
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
    return this.mutateExisting({
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

  async transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[2],
    nextStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[3],
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mutateExisting({
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
    return this.mutateExisting({
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
    return this.mutateExisting({
      jobId,
      whereSql: `tenant_id = ? AND status IN (${allowed.map(() => "?").join(", ")})`,
      whereParams: [tenantId, ...allowed],
      predicate: (record) => record.tenantId === tenantId && statusIn(record, allowed),
      mutate: (record) => {
        record.status = "DELETING";
        record.updatedAt = at;
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
    return this.mutateExisting({
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
      const row = await this.getDeploymentRow(entry.replacesJobId);
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
      await this.sql.batch(statements);
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
    return this.mutateExisting({
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
    return this.mutateExisting({
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

  async appendScoreEvent(record: ScoreEventRecord): Promise<void> {
    await this.sql.run(
      "INSERT INTO deployment_score_events " +
        "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      [
        record.jobId,
        `${SCORE_EVENT_SK_PREFIX}${record.occurredAt}#${ulid()}`,
        "score",
        record.occurredAt,
        Number(record.expiresAt ?? 0),
        JSON.stringify(normalizeJsonValue(record)),
      ],
    );
  }

  async appendInboxEvent(jobId: string, inboxId: string, record: InboxEventRecord): Promise<void> {
    const payload = {
      eventId: record.eventId,
      fromTeamId: record.fromTeamId,
      fromJobId: record.fromJobId,
      kind: record.kind,
      payload: record.payload ?? {},
      occurredAt: record.occurredAt,
      ttl: record.ttl,
    };
    await this.sql.run(
      "INSERT INTO deployment_score_events " +
        "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      [
        jobId,
        `${INBOX_EVENT_SK_PREFIX}${record.occurredAt}#${inboxId}`,
        "inbox",
        record.occurredAt ?? null,
        Number(record.ttl ?? 0),
        JSON.stringify(normalizeJsonValue(payload)),
      ],
    );
  }

  async writeCoordinationState(
    tenantId: string,
    eventId: string,
    state: unknown,
    expectedVersion: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const result = await this.sql.run(
      `INSERT INTO coordination_state (tenant_id, event_id, state, version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, event_id) DO UPDATE SET
         state = excluded.state,
         version = excluded.version,
         updated_at = excluded.updated_at
       WHERE coordination_state.version = ?`,
      [
        tenantId,
        eventId,
        JSON.stringify(normalizeJsonValue(state)),
        expectedVersion + 1,
        at,
        expectedVersion,
      ],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "conflict" };
  }
}
