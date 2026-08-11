import {
  type ProgressionGateConfig,
  parseProgressionGate,
} from "../handlers/shared/progression-gate.js";
import { TEAM_INSERT_SQL, teamRowParams } from "./sql-teams-repository.js";
import type {
  ClearProgressionGateOutcome,
  CreateEventWithTeamsOutcome,
  EventMutationOutcome,
  EventRecord,
  EventSchedulePatch,
  EventScoringMeta,
  EventsPage,
  EventsRepository,
  ScheduleFiredKind,
  SqlExecutor,
  SqlParam,
  SqlStatement,
  TeamRecord,
} from "./types.js";

/**
 * [#2438 / Phase A3] Opaque keyset cursor for {@link SqlEventsRepository.listEventsPage}
 * — a `(createdAt, eventId)` tiebreak pair matching the `ORDER BY created_at DESC,
 * event_id DESC` used by both this method and {@link SqlEventsRepository.listEventsByTenant}.
 * Deliberately a **different wire format** than the DynamoDB backend's
 * `ExclusiveStartKey`-based cursor: a cursor minted by one backend decodes to
 * `undefined` on the other (missing `createdAt`/`eventId` keys), which safely
 * restarts pagination from the first page instead of crashing.
 */
interface EventsKeysetCursor {
  readonly createdAt: string;
  readonly eventId: string;
}

function encodeKeysetCursor(cursor: EventsKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeKeysetCursor(cursor: string): EventsKeysetCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { createdAt, eventId } = parsed as Partial<EventsKeysetCursor>;
  if (typeof createdAt !== "string" || typeof eventId !== "string") return undefined;
  return { createdAt, eventId };
}

/**
 * SQLite implementation of {@link EventsRepository}. One
 * SQL layer in the SQLite dialect targets the Turso (libSQL) hosted backend
 * (#2677: Turso-only — the Always-On Cloudflare Worker holds its own D1 binding
 * and never routes through this seam). It talks to an injected
 * {@link SqlExecutor} so it carries no client dependency of its own — `node:sqlite`
 * backs it in tests, a future `@libsql/client` adapter backs it in production.
 *
 * Schema: the full record is stored as a JSON `payload` so new event attributes
 * round-trip without a migration, with denormalized columns for the query paths
 * that must be indexable (tenant listing, TTL prune) rather than JSON-scanned.
 */
export const EVENTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT    PRIMARY KEY,
  tenant_id  TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_events_tenant_created
  ON events (tenant_id, created_at DESC)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const EVENTS_SCHEMA_SQL = `${EVENTS_SCHEMA_STATEMENTS.join(";\n")};`;

/**
 * [#2437] Column list + positional params for inserting one event row. Shared by
 * {@link SqlEventsRepository.putEvent} (upsert) and
 * {@link SqlEventsRepository.createEventWithTeams} (plain insert inside the
 * atomic batch) so both write the same denormalized columns + payload.
 */
const EVENT_INSERT_SQL =
  "INSERT INTO events (event_id, tenant_id, status, created_at, expires_at, payload) " +
  "VALUES (?, ?, ?, ?, ?, ?)";

function eventRowParams(record: EventRecord): SqlParam[] {
  return [
    record.eventId,
    record.tenantId,
    record.status,
    record.createdAt,
    record.expiresAt,
    JSON.stringify(record),
  ];
}

export class SqlEventsRepository implements EventsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined> {
    const row = await this.sql.get("SELECT tenant_id, payload FROM events WHERE event_id = ?", [
      eventId,
    ]);
    // Same guard as the DDB backend: absent row or tenant mismatch → undefined.
    if (!row || row.tenant_id !== tenantId) return undefined;
    return JSON.parse(String(row.payload)) as EventRecord;
  }

  async putEvent(record: EventRecord): Promise<void> {
    await this.sql.run(
      `${EVENT_INSERT_SQL} ` +
        "ON CONFLICT(event_id) DO UPDATE SET " +
        "tenant_id = excluded.tenant_id, status = excluded.status, " +
        "created_at = excluded.created_at, expires_at = excluded.expires_at, " +
        "payload = excluded.payload",
      eventRowParams(record),
    );
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.sql.run("DELETE FROM events WHERE event_id = ?", [eventId]);
  }

  async listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]> {
    const rows = await this.sql.all(
      // event_id tiebreak keeps ordering deterministic when createdAt collides.
      "SELECT payload FROM events WHERE tenant_id = ? ORDER BY created_at DESC, event_id DESC",
      [tenantId],
    );
    return rows.map((row) => JSON.parse(String(row.payload)) as EventRecord);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM events WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }

  async listEventsPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<EventsPage> {
    const after = opts.cursor ? decodeKeysetCursor(opts.cursor) : undefined;
    // Fetch one extra row to know whether a next page exists without a second round trip.
    const rows = after
      ? await this.sql.all(
          "SELECT payload, created_at, event_id FROM events WHERE tenant_id = ? " +
            "AND (created_at < ? OR (created_at = ? AND event_id < ?)) " +
            "ORDER BY created_at DESC, event_id DESC LIMIT ?",
          [tenantId, after.createdAt, after.createdAt, after.eventId, opts.limit + 1],
        )
      : await this.sql.all(
          "SELECT payload, created_at, event_id FROM events WHERE tenant_id = ? " +
            "ORDER BY created_at DESC, event_id DESC LIMIT ?",
          [tenantId, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const events = page.map((row) => JSON.parse(String(row.payload)) as EventRecord);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeKeysetCursor({
            createdAt: String(last.created_at),
            eventId: String(last.event_id),
          })
        : undefined;
    return { events, nextCursor };
  }

  async listEventsByStatus(statuses: readonly string[]): Promise<readonly EventRecord[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = await this.sql.all(
      // event_id tiebreak keeps ordering deterministic for tests; the reconciler
      // (the sole caller) processes matches independent of order.
      `SELECT payload FROM events WHERE status IN (${placeholders}) ORDER BY event_id`,
      statuses,
    );
    return rows.map((row) => JSON.parse(String(row.payload)) as EventRecord);
  }

  async batchGetEvents(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, EventScoringMeta>> {
    const map = new Map<string, EventScoringMeta>();
    if (eventIds.length === 0) return map;
    // [PR #2455 review] `IN (...)` tolerates duplicates/any length on its own, but
    // dedupe + the 100-id cap are enforced here too so both backends agree on the
    // same input contract (mirrors createEventWithTeams's symmetric 100-item cap).
    const ids = [...new Set(eventIds)];
    if (ids.length > 100) {
      throw new Error(
        `batchGetEvents: ${ids.length} distinct ids exceeds the 100-key BatchGet limit`,
      );
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.sql.all(
      `SELECT event_id, payload FROM events WHERE event_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      const record = JSON.parse(String(row.payload)) as EventRecord;
      map.set(String(row.event_id), {
        scoringLocked: record.scoringLocked === true,
        progressionGate: parseProgressionGate(record.progressionGate),
      });
    }
    return map;
  }

  async countEventsByTenant(tenantId: string): Promise<number> {
    const row = await this.sql.get("SELECT COUNT(*) as cnt FROM events WHERE tenant_id = ?", [
      tenantId,
    ]);
    return Number(row?.cnt ?? 0);
  }

  // ---------------------------------------------------------------------------
  // [Issue #2437 / Phase A2] Conditional writes. SQL raises no exception on a
  // failed condition — the row simply doesn't match — so every method issues a
  // single conditional `UPDATE` (`… RETURNING payload` when the DDB twin runs
  // ALL_NEW; plain `changes`-count otherwise) and interprets a miss per the DDB
  // backend's semantics for that method. The JSON `payload` is the record of
  // truth; the denormalized `status` column is synced in the SAME statement.
  // ---------------------------------------------------------------------------

  /**
   * One conditional update. `onMiss` mirrors the DDB backend's CCF handling per
   * method: `probe` re-reads to split not_found/conflict, `conflict` folds every
   * miss to conflict (fire-and-forget callers), `not_found` folds every miss to
   * not_found (tenant-scope-only conditions).
   *
   * `withPostImage` mirrors the DDB backend's ReturnValues per method: methods
   * whose DDB twin runs ALL_NEW use `UPDATE … RETURNING payload` (one statement,
   * no update→re-read race); methods whose DDB twin returns nothing skip the
   * RETURNING round-trip payload and report via `changes` only, so the
   * updated-arm shape matches across backends.
   */
  private async conditionalUpdate(args: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly set: string;
    readonly setParams: readonly SqlParam[];
    readonly where?: string;
    readonly whereParams?: readonly SqlParam[];
    readonly onMiss: "probe" | "conflict" | "not_found";
    readonly withPostImage: boolean;
  }): Promise<EventMutationOutcome> {
    const sql =
      `UPDATE events SET ${args.set} WHERE event_id = ? AND tenant_id = ?` +
      `${args.where ? ` AND (${args.where})` : ""}`;
    const params = [...args.setParams, args.eventId, args.tenantId, ...(args.whereParams ?? [])];
    let hit: EventMutationOutcome | undefined;
    if (args.withPostImage) {
      const rows = await this.sql.all(`${sql} RETURNING payload`, params);
      const row = rows[0];
      if (row) hit = { outcome: "updated", event: JSON.parse(String(row.payload)) as EventRecord };
    } else {
      const result = await this.sql.run(sql, params);
      if (Number(result.changes) > 0) hit = { outcome: "updated" };
    }
    if (hit) return hit;
    if (args.onMiss === "conflict") return { outcome: "conflict" };
    if (args.onMiss === "not_found") return { outcome: "not_found" };
    const event = await this.getEvent(args.tenantId, args.eventId);
    if (!event) return { outcome: "not_found" };
    return { outcome: "conflict", event };
  }

  async endEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    // #1095: ENDED 遷移と同時に scoringLocked 一式を立てる (DDB backend と同一の合成 write)。
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set:
        "status = ?, payload = json_set(payload, '$.status', ?, '$.endsAt', ?, '$.updatedAt', ?, " +
        "'$.scoringLocked', json('true'), '$.scoringLockedAt', ?, '$.scoringLockedBy', ?)",
      setParams: ["ENDED", "ENDED", at, at, at, "system:end-event"],
      where: "status = ?",
      whereParams: ["READY"],
      onMiss: "probe",
      withPostImage: true,
    });
  }

  async lockScoring(
    tenantId: string,
    eventId: string,
    lockedBy: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    // attribute_not_exists(scoringLocked) OR scoringLocked = false 相当:
    // json_type IS NULL = 属性不在、 json_extract = 0 = JSON false。
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set:
        "payload = json_set(payload, '$.scoringLocked', json('true'), " +
        "'$.scoringLockedAt', ?, '$.scoringLockedBy', ?, '$.updatedAt', ?)",
      setParams: [at, lockedBy, at],
      where:
        "status IN (?, ?) AND (json_type(payload, '$.scoringLocked') IS NULL " +
        "OR json_extract(payload, '$.scoringLocked') = 0)",
      whereParams: ["READY", "ENDED"],
      onMiss: "probe",
      withPostImage: true,
    });
  }

  async unlockScoring(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set:
        "payload = json_set(json_remove(payload, '$.scoringLocked', '$.scoringLockedAt', " +
        "'$.scoringLockedBy'), '$.updatedAt', ?)",
      setParams: [at],
      where: "status IN (?, ?) AND json_extract(payload, '$.scoringLocked') = 1",
      whereParams: ["READY", "ENDED"],
      onMiss: "probe",
      withPostImage: true,
    });
  }

  async archiveEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: "status = ?, payload = json_set(payload, '$.status', ?, '$.archivedAt', ?, '$.updatedAt', ?)",
      setParams: ["ARCHIVED", "ARCHIVED", at, at],
      where: "status IN (?, ?, ?)",
      whereParams: ["DRAFT", "ENDED", "TEARDOWN"],
      onMiss: "probe",
      withPostImage: false,
    });
  }

  async updateSchedule(
    tenantId: string,
    eventId: string,
    patch: EventSchedulePatch,
    at: string,
  ): Promise<EventMutationOutcome> {
    // 動的 json_set (DDB backend の動的 SET と同じ「指定された field のみ」を書く)。
    const pairs = ["'$.updatedAt', ?"];
    const params: SqlParam[] = [at];
    if (patch.startsAt !== undefined) {
      pairs.push("'$.startsAt', ?");
      params.push(patch.startsAt);
    }
    if (patch.endsAt !== undefined) {
      pairs.push("'$.endsAt', ?");
      params.push(patch.endsAt);
    }
    if (patch.teardownAt !== undefined) {
      pairs.push("'$.teardownAt', ?");
      params.push(patch.teardownAt);
    }
    if (patch.deployAt !== undefined) {
      pairs.push("'$.deployAt', ?");
      params.push(patch.deployAt);
    }
    if (patch.scoreboardFreezeMinutes !== undefined) {
      pairs.push("'$.scoreboardFreezeMinutes', ?");
      params.push(patch.scoreboardFreezeMinutes);
    }
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: `payload = json_set(payload, ${pairs.join(", ")})`,
      setParams: params,
      onMiss: "not_found",
      withPostImage: true,
    });
  }

  async markTeardown(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: "status = ?, payload = json_set(payload, '$.status', ?, '$.updatedAt', ?)",
      setParams: ["TEARDOWN", "TEARDOWN", at],
      where: "status <> ?",
      whereParams: ["ARCHIVED"],
      onMiss: "conflict",
      withPostImage: false,
    });
  }

  async setProgressionGate(
    tenantId: string,
    eventId: string,
    config: ProgressionGateConfig,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: "payload = json_set(payload, '$.progressionGate', json(?), '$.updatedAt', ?)",
      setParams: [JSON.stringify(config), at],
      onMiss: "not_found",
      withPostImage: false,
    });
  }

  async clearProgressionGate(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<ClearProgressionGateOutcome> {
    // ALL_OLD 相当の「gate があったか」は、 gate 有り条件付き除去 (removed 判定) と
    // updatedAt touch (存在判定) を **1 つの write トランザクション** (batch) で実行して
    // 判定する — DDB の単一条件付き UPDATE と同じく、 並行する setProgressionGate との
    // interleaving が入り込む隙間がない (libSQL では 1 HTTP round trip)。
    const [removeResult, touchResult] = await this.sql.batch([
      {
        sql:
          "UPDATE events SET payload = json_set(json_remove(payload, '$.progressionGate'), " +
          "'$.updatedAt', ?) WHERE event_id = ? AND tenant_id = ? " +
          "AND json_type(payload, '$.progressionGate') IS NOT NULL",
        params: [at, eventId, tenantId],
      },
      {
        sql:
          "UPDATE events SET payload = json_set(payload, '$.updatedAt', ?) " +
          "WHERE event_id = ? AND tenant_id = ?",
        params: [at, eventId, tenantId],
      },
    ]);
    if (Number(touchResult?.changes ?? 0) === 0) return { outcome: "not_found" };
    return { outcome: "updated", removed: Number(removeResult?.changes ?? 0) > 0 };
  }

  async markDeploying(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: "status = ?, payload = json_set(payload, '$.status', ?, '$.updatedAt', ?)",
      setParams: ["DEPLOYING", "DEPLOYING", at],
      where: "status IN (?, ?, ?)",
      whereParams: ["DRAFT", "READY", "DEPLOYING"],
      onMiss: "conflict",
      withPostImage: false,
    });
  }

  async transitionStatus(
    tenantId: string,
    eventId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: "status = ?, payload = json_set(payload, '$.status', ?, '$.updatedAt', ?)",
      setParams: [to, to, at],
      where: "status = ?",
      whereParams: [from],
      onMiss: "conflict",
      withPostImage: false,
    });
  }

  async markScheduleFired(
    tenantId: string,
    eventId: string,
    kind: ScheduleFiredKind,
    at: string,
  ): Promise<EventMutationOutcome> {
    // path は固定の literal union 由来なので SQL への injection はない。
    // DDB backend と同じく updatedAt は触らない (冪等 audit marker のみ)。
    const path = kind === "teardown" ? "$.teardownFiredAt" : "$.deployFiredAt";
    return this.conditionalUpdate({
      tenantId,
      eventId,
      set: `payload = json_set(payload, '${path}', ?)`,
      setParams: [at],
      where: `json_type(payload, '${path}') IS NULL`,
      onMiss: "conflict",
      withPostImage: false,
    });
  }

  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<CreateEventWithTeamsOutcome> {
    // DDB TransactWrite の 100-item 上限 (event 1 行 + teams 99) と同じ cap を敷いて
    // backend 間で受け入れ条件を揃える (schema teams.max(99) の defense-in-depth)。
    if (teams.length + 1 > 100) {
      throw new Error(`TransactWrite items > 100 (teams=${teams.length} + event=1)`);
    }
    // 行のマーシャリングは putEvent / putTeam と同じ builder を使う (= denormalized
    // column / sparse login_key_hash / payload scrub のルールが経路間でズレない)。
    const statements: SqlStatement[] = [
      { sql: EVENT_INSERT_SQL, params: eventRowParams(event) },
      ...teams.map((team) => ({ sql: TEAM_INSERT_SQL, params: teamRowParams(team) })),
    ];
    try {
      await this.sql.batch(statements);
      return { outcome: "created" };
    } catch (err) {
      // 一意性違反 (PK / UNIQUE index) = DDB の attribute_not_exists 不成立と同義 →
      // conflict に変換。 batch はトランザクションなので部分書き込みは残らない。
      if (isUniqueConstraintViolation(err)) return { outcome: "conflict" };
      throw err;
    }
  }
}

/**
 * SQLite dialect uniqueness-violation detector, covering both drivers we run
 * on: `node:sqlite` ("UNIQUE constraint failed: …") and `@libsql/client`
 * (`LibsqlError` carries `code = "SQLITE_CONSTRAINT"` with the specific
 * `SQLITE_CONSTRAINT_PRIMARYKEY` / `_UNIQUE` value on `extendedCode`).
 * Deliberately narrow: only PRIMARY KEY / UNIQUE violations convert to
 * `conflict` — other constraint classes (NOT NULL / CHECK / FK) signal a data
 * bug and must keep failing loudly.
 */
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
