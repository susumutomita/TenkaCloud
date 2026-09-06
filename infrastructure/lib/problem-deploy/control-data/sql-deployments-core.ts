import { PRE_SCOPE_COORDINATION_NAMESPACE } from "./domain/coordination-scope.js";
import { hashLoginKey } from "./sql-teams-repository.js";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentMutationOutcome,
  DeploymentRecord,
  InboxEventRecord,
  ScoreEventRecord,
  SqlExecutor,
  SqlParam,
  SqlRow,
} from "./types.js";

export type DeploymentWriteRecord =
  | DeploymentRecord
  | CompositeParentDeploymentRecord
  | CompositeTargetDeploymentRecord;

export type MutableDeploymentRecord = Record<string, unknown> & DeploymentRecord;

export interface DeploymentsKeysetCursor {
  readonly createdAt: string;
  readonly jobId: string;
}

export const SCORE_EVENT_SK_PREFIX = "EVENT#" as const;
export const INBOX_EVENT_SK_PREFIX = "INBOX#" as const;

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
  // [Issue #3123] Coordination state is keyed by tenant x event x problem x run.
  //
  // The pre-#3123 table was `PRIMARY KEY (tenant_id, event_id)`, so two
  // coordination problems in one event overwrote each other. SQLite cannot
  // widen a primary key in place, so the new shape needs a new table and the
  // four statements below migrate into it. They are ordered to be idempotent on
  // every cold start, not just the first:
  //
  //   1. create the legacy table if absent (an empty source for step 3 on a
  //      brand-new database)
  //   2. create the scoped table
  //   3. copy any legacy row into the reserved `__pre_scope__` namespace
  //
  // Step 3 preserves the rows rather than dropping them, but parks them where
  // no live scope can resolve: a real `problemId` matches `PROBLEM_ID_RE`
  // (`handlers/shared/constants.ts`), which forbids `_`. That is deliberate.
  // Reading a legacy row back as live state would hand ONE problem's game state
  // to whichever OTHER problem in the same event happened to ask first — the
  // exact cross-problem bleed this issue fixes. The compatibility policy is
  // therefore: pre-#3123 coordination state does not carry over, and a match in
  // flight across the deploy re-initializes from `plugin.initialState`.
  //
  // The legacy table is deliberately NOT dropped. Turso is one shared remote
  // database, so during a rolling deployment the first NEW cold start runs this
  // bootstrap while OLD execution environments are still serving traffic
  // against `coordination_state` — dropping it would fail every one of their
  // reads and writes with `no such table` until the rollout drained. Leaving it
  // costs a stale table that nothing reads; an operator can drop it once no old
  // environment remains.
  `CREATE TABLE IF NOT EXISTS coordination_state (
  tenant_id  TEXT    NOT NULL,
  event_id   TEXT    NOT NULL,
  state      TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
)`,
  `CREATE TABLE IF NOT EXISTS coordination_state_scoped (
  tenant_id  TEXT    NOT NULL,
  event_id   TEXT    NOT NULL,
  problem_id TEXT    NOT NULL,
  run_id     TEXT    NOT NULL,
  state      TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, event_id, problem_id, run_id)
)`,
  // [Issue #3153] Which run of a problem is current, and which runs came before.
  // One level ABOVE `coordination_state_scoped`: this table is keyed by
  // `(tenant, event, problem)` with no run column, because it is what NAMES the
  // run. History is a JSON array rather than a second table — it is a short,
  // ordered list read only alongside the pointer, so a join would buy nothing
  // and a row per retired run would need its own lifecycle.
  `CREATE TABLE IF NOT EXISTS coordination_run (
  tenant_id  TEXT    NOT NULL,
  event_id   TEXT    NOT NULL,
  problem_id TEXT    NOT NULL,
  run_id     TEXT    NOT NULL,
  started_at TEXT    NOT NULL,
  history    TEXT    NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, event_id, problem_id)
)`,
  // [Issue #3133] The match secret lives in its OWN table, not as a column on
  // `coordination_state_scoped`. Two reasons, and the second is why a column
  // was rejected even though it would have been less code:
  //   - `readCoordinationState`'s SELECT names its columns, so a secret column
  //     could only leak through a future edit. A separate table means the
  //     secret is not reachable from that query at all.
  //   - `CREATE TABLE IF NOT EXISTS` is idempotent inside the atomic bootstrap
  //     batch. Adding a column to a table that already exists on a live Turso
  //     database needs `ALTER TABLE`, which errors on the second cold start and
  //     would take the whole batch — every other aggregate's schema — with it.
  `CREATE TABLE IF NOT EXISTS coordination_match_secret (
  tenant_id    TEXT    NOT NULL,
  event_id     TEXT    NOT NULL,
  problem_id   TEXT    NOT NULL,
  run_id       TEXT    NOT NULL,
  match_secret TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, event_id, problem_id, run_id)
)`,
  `INSERT OR IGNORE INTO coordination_state_scoped
  (tenant_id, event_id, problem_id, run_id, state, version, updated_at, expires_at)
  SELECT tenant_id, event_id, '${PRE_SCOPE_COORDINATION_NAMESPACE}', '${PRE_SCOPE_COORDINATION_NAMESPACE}', state, version, updated_at, 0
  FROM coordination_state`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const DEPLOYMENTS_SCHEMA_SQL = `${DEPLOYMENTS_SCHEMA_STATEMENTS.join(";\n")};`;

export const DEPLOYMENT_COLUMNS =
  "(job_id, tenant_id, list_tenant_id, status, created_at, updated_at, expires_at, " +
  "login_key_hash, parent_deployment_id, target_ordinal, target_id, runtime_kind, " +
  "runtime_provider, event_id, team_id, problem_id, name_prefix, score, payload)";

export const DEPLOYMENT_INSERT_SQL =
  `INSERT INTO deployments ${DEPLOYMENT_COLUMNS} ` +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export const DEPLOYMENT_UPDATE_SET =
  "tenant_id = ?, list_tenant_id = ?, status = ?, created_at = ?, updated_at = ?, " +
  "expires_at = ?, login_key_hash = ?, parent_deployment_id = ?, target_ordinal = ?, " +
  "target_id = ?, runtime_kind = ?, runtime_provider = ?, event_id = ?, team_id = ?, " +
  "problem_id = ?, name_prefix = ?, score = ?, payload = ?";

/**
 * [Issue #2672] Update clause for read-modify-write mutations that rebuild the
 * record from `payload` — which, by [Issue #2290], deliberately omits the
 * credential (`teamLoginKey` / `teamLoginKeyHash`). Writing `login_key_hash`
 * from such a record would `resolveLoginKeyHash → null` and wipe the column,
 * breaking participant login (`listByTeamLoginKey` returns 0 rows). So this SET
 * omits `login_key_hash`, leaving the stored value untouched. The credential is
 * written only by paths that hold the real value: `DEPLOYMENT_INSERT_SQL` (put)
 * and the upsert conflict clause. Intentional clears (`markDeleted`) use the
 * full `DEPLOYMENT_UPDATE_SET` with a credential-stripped record on purpose.
 */
export const DEPLOYMENT_MUTATE_SET =
  "tenant_id = ?, list_tenant_id = ?, status = ?, created_at = ?, updated_at = ?, " +
  "expires_at = ?, parent_deployment_id = ?, target_ordinal = ?, " +
  "target_id = ?, runtime_kind = ?, runtime_provider = ?, event_id = ?, team_id = ?, " +
  "problem_id = ?, name_prefix = ?, score = ?, payload = ?";

export function encodeCursor(cursor: DeploymentsKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): DeploymentsKeysetCursor | undefined {
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

export function isCompositeParentRecord(
  record: DeploymentWriteRecord,
): record is CompositeParentDeploymentRecord {
  return (record as { runtimeKind?: unknown }).runtimeKind === "composite";
}

export function isCompositeTargetRecord(
  record: DeploymentWriteRecord,
): record is CompositeTargetDeploymentRecord {
  return typeof (record as { parentDeploymentId?: unknown }).parentDeploymentId === "string";
}

export function normalizeJsonValue(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = normalizeJsonValue(entry);
  }
  return out;
}

export function payloadWithoutLoginKey(record: DeploymentWriteRecord): string {
  const {
    teamLoginKey: _teamLoginKey,
    teamLoginKeyHash: _teamLoginKeyHash,
    ...safeRecord
  } = record as Record<string, unknown>;
  return JSON.stringify(normalizeJsonValue(safeRecord));
}

export function deploymentFromPayload(
  payload: unknown,
  restoreLoginKey?: string,
): DeploymentRecord {
  const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
  if (Array.isArray(parsed.solvedFlagIds)) {
    parsed.solvedFlagIds = new Set(parsed.solvedFlagIds);
  }
  if (restoreLoginKey) parsed.teamLoginKey = restoreLoginKey;
  return parsed as DeploymentRecord;
}

export function scoreEventFromPayload(payload: unknown): ScoreEventRecord {
  return JSON.parse(String(payload)) as ScoreEventRecord;
}

export function inboxEventFromPayload(payload: unknown): InboxEventRecord {
  return JSON.parse(String(payload)) as InboxEventRecord;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Select the SQL-only credential representation without accepting ambiguous input. */
function resolveLoginKeyHash(record: DeploymentWriteRecord, normalTenantId: string | null) {
  if (!normalTenantId) return null;
  const plaintext = (record as { teamLoginKey?: unknown }).teamLoginKey;
  const prehashed = (record as { teamLoginKeyHash?: unknown }).teamLoginKeyHash;
  if (typeof plaintext === "string" && typeof prehashed === "string") {
    throw new Error("Provide a plaintext or pre-hashed login credential, not both");
  }
  if (typeof prehashed === "string") {
    if (!SHA256_HEX_RE.test(prehashed)) {
      throw new Error("Expected a valid SHA-256 login credential");
    }
    return prehashed;
  }
  return typeof plaintext === "string" && plaintext.length > 0 ? hashLoginKey(plaintext) : null;
}

export function deploymentRowParams(record: DeploymentWriteRecord): SqlParam[] {
  const normalTenantId =
    !isCompositeParentRecord(record) && !isCompositeTargetRecord(record) ? record.tenantId : null;
  const loginKeyHash = resolveLoginKeyHash(record, normalTenantId);
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

export function deploymentUpdateParams(record: DeploymentWriteRecord): SqlParam[] {
  return deploymentRowParams(record).slice(1);
}

/**
 * [Issue #2672] Params for {@link DEPLOYMENT_MUTATE_SET}: the update params with
 * the `login_key_hash` value (index 6 of the 18-column update tuple) dropped, so
 * a read-modify-write never overwrites the stored credential with null.
 */
export function deploymentMutateParams(record: DeploymentWriteRecord): SqlParam[] {
  const params = deploymentUpdateParams(record);
  return [...params.slice(0, 6), ...params.slice(7)];
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJsonValue(left)) === JSON.stringify(normalizeJsonValue(right));
}

export function statusIn(record: DeploymentRecord, statuses: readonly string[]): boolean {
  return statuses.includes(String(record.status));
}

export function getSolvedFlagSet(record: MutableDeploymentRecord): Set<string> {
  const current = record.solvedFlagIds;
  if (current instanceof Set) return new Set([...current].map(String));
  if (Array.isArray(current)) return new Set(current.map(String));
  return new Set();
}

export function ensureNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function isUniqueConstraintViolation(err: unknown): boolean {
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

/**
 * [#2527 Slice 3] Shared SQLite (Turso/libSQL) engine for the Deployments capability
 * adapters: the backend handle plus the conflict-probe / conditional-write /
 * row-mapping / pagination primitives every capability reuses. Extracted
 * verbatim from the pre-split `SqlDeploymentsRepository`; the capability
 * classes hold one shared instance instead of re-implementing the engine.
 */
export class SqlDeploymentsCore {
  constructor(readonly sql: SqlExecutor) {}

  async getDeploymentRow(jobId: string): Promise<SqlRow | undefined> {
    return this.sql.get("SELECT * FROM deployments WHERE job_id = ?", [jobId]);
  }

  async putRecord(record: DeploymentWriteRecord): Promise<void> {
    await this.sql.run(
      `${DEPLOYMENT_INSERT_SQL} ON CONFLICT(job_id) DO UPDATE SET ${DEPLOYMENT_UPDATE_SET}`,
      [...deploymentRowParams(record), ...deploymentUpdateParams(record)],
    );
  }

  async probeConflict(tenantId: string, jobId: string): Promise<DeploymentMutationOutcome> {
    const record = await this.getDeployment(jobId);
    if (!record || record.tenantId !== tenantId) return { outcome: "not_found" };
    return { outcome: "conflict", record };
  }

  async handleMiss(
    jobId: string,
    onMiss: "conflict" | "not_found" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    if (onMiss === "conflict") return { outcome: "conflict" };
    if (onMiss === "not_found") return { outcome: "not_found" };
    return this.probeConflict(onMiss.probeTenantId, jobId);
  }

  async mutateExisting(args: {
    readonly jobId: string;
    readonly whereSql?: string;
    readonly whereParams?: readonly SqlParam[];
    /** Re-evaluated after a lost CAS; must not perform external side effects. */
    readonly predicate: (record: DeploymentRecord, row: SqlRow) => boolean;
    /** Mutates this attempt's private record only; may run again after a lost CAS. */
    readonly mutate: (record: MutableDeploymentRecord) => void;
    readonly onMiss: "conflict" | "not_found" | { readonly probeTenantId: string };
    readonly withPostImage?: boolean;
  }): Promise<DeploymentMutationOutcome> {
    // [#3194] A full payload rewrite must not erase a score/subtotal or another
    // field committed after our read. Retry from the winner's record, including
    // its predicate, rather than applying the mutation computed from stale data.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.getDeploymentRow(args.jobId);
      if (!row) return this.handleMiss(args.jobId, args.onMiss);
      const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
      if (!args.predicate(record, row)) return this.handleMiss(args.jobId, args.onMiss);
      args.mutate(record);
      // [#2672] Payload omits the credential, so keep login_key_hash untouched.
      const params = [
        ...deploymentMutateParams(record),
        args.jobId,
        String(row.payload),
        ...(args.whereParams ?? []),
      ];
      const where = args.whereSql ? ` AND (${args.whereSql})` : "";
      const update = `UPDATE deployments SET ${DEPLOYMENT_MUTATE_SET} WHERE job_id = ? AND payload = ?${where}`;
      if (args.withPostImage) {
        const rows = await this.sql.all(`${update} RETURNING payload`, params);
        const updated = rows[0];
        if (!updated) continue;
        return {
          outcome: "updated",
          record: deploymentFromPayload(updated.payload),
        };
      }
      const result = await this.sql.run(update, params);
      if (Number(result.changes) > 0) return { outcome: "updated" };
    }
    return { outcome: "conflict" };
  }

  async mutateCreateStatusWrite(
    jobId: string,
    mutate: (record: MutableDeploymentRecord) => void,
  ): Promise<DeploymentMutationOutcome> {
    // SFN may redeliver completion after the team has started scoring. Use the
    // same payload CAS so its status write cannot restore an earlier score.
    return this.mutateExisting({ jobId, predicate: () => true, mutate, onMiss: "not_found" });
  }

  async conditionalInsert(
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

  selectRows(sql: string, params: readonly SqlParam[] = []): Promise<readonly SqlRow[]> {
    return Promise.resolve(this.sql.all(sql, params));
  }

  records(rows: readonly SqlRow[], restoreLoginKey?: string): readonly DeploymentRecord[] {
    return rows.map((row) => deploymentFromPayload(row.payload, restoreLoginKey));
  }

  async getDeployment(jobId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.sql.get("SELECT payload FROM deployments WHERE job_id = ?", [jobId]);
    return row ? deploymentFromPayload(row.payload) : undefined;
  }
}
