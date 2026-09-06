import { ulid } from "ulid";
import type { CoordinationRunKey, CoordinationRunPointer } from "./domain/coordination-run.js";
import {
  assertConditionableVersion,
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "./domain/coordination-scope.js";
import type { CoordinationScoreUpdate } from "./domain/coordination-score.js";
import { normalizeJsonValue, type SqlDeploymentsCore } from "./sql-deployments-core.js";
import type { SqlStatement } from "./sql-port.js";
import type {
  CoordinationStateRecord,
  DeploymentMutationOutcome,
  DeploymentsCoordinationPort,
} from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsCoordinationPort} adapter — optimistic-lock coordination plugin state,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 *
 * [Issue #3123] Rows live in `coordination_state_scoped`, keyed by
 * `(tenant_id, event_id, problem_id, run_id)`. See `sql-deployments-core.ts`
 * for the migration off the old two-column key and the compatibility policy.
 */
export class SqlDeploymentsCoordination implements DeploymentsCoordinationPort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async publishCoordinationScore(
    scope: CoordinationStateScope,
    version: number,
    update: CoordinationScoreUpdate,
  ): Promise<DeploymentMutationOutcome> {
    const at = update.events[0]?.occurredAt ?? "";
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE deployments SET score = ?, updated_at = ?,
          payload = json_set(payload, '$.score', ?, '$.updatedAt', ?, '$.coordinationScoreRunId', ?, '$.coordinationScoreVersion', ?)
          WHERE job_id = ? AND tenant_id = ? AND event_id = ? AND problem_id = ? AND team_id = ? AND status = ?
          AND json_extract(payload, '$.teardownRequestedAt') IS NULL AND score IS ?
          AND (json_extract(payload, '$.coordinationScoreRunId') IS NOT ? OR json_extract(payload, '$.coordinationScoreVersion') < ?)
          AND COALESCE((SELECT run_id FROM coordination_run WHERE tenant_id = ? AND event_id = ? AND problem_id = ?), ?) = ?
          AND EXISTS (SELECT 1 FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?
            AND version = ? AND json_extract(state, '$.pendingScores') IS NOT NULL)`,
        params: [
          update.score,
          at,
          update.score,
          at,
          scope.runId,
          version,
          update.jobId,
          scope.tenantId,
          scope.eventId,
          scope.problemId,
          update.teamId,
          update.expectedStatus,
          update.expectedScore ?? null,
          scope.runId,
          version,
          scope.tenantId,
          scope.eventId,
          scope.problemId,
          DEFAULT_COORDINATION_RUN_ID,
          scope.runId,
          scope.tenantId,
          scope.eventId,
          scope.problemId,
          scope.runId,
          version,
        ],
      },
      // The existing score-event NOT NULL constraint turns a missed CAS into a rollback.
      // A batch is atomic but UPDATE matching zero rows does not itself abort SQLite.
      {
        sql: "INSERT INTO deployment_score_events (job_id, sk, record_type, payload) SELECT 'coordination-score-cas', '', 'score', NULL WHERE changes() <> 1",
      },
      ...update.events.map((event) => ({
        sql: "INSERT INTO deployment_score_events (job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
        params: [
          update.jobId,
          `EVENT#${event.occurredAt}#${ulid()}`,
          "score",
          event.occurredAt,
          event.expiresAt,
          JSON.stringify(event),
        ],
      })),
    ];
    try {
      await this.core.sql.batch(statements);
      return { outcome: "updated" };
    } catch (error) {
      if (
        error instanceof Error &&
        /NOT NULL constraint failed: deployment_score_events.payload/.test(error.message)
      )
        return { outcome: "conflict" };
      throw error;
    }
  }

  async acknowledgeCoordinationScores(
    scope: CoordinationStateScope,
    version: number,
  ): Promise<void> {
    await this.core.sql.run(
      "UPDATE coordination_state_scoped SET state = json_remove(state, '$.pendingScores') WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ? AND version = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId, version],
    );
  }

  async readCoordinationState(
    scope: CoordinationStateScope,
  ): Promise<CoordinationStateRecord | undefined> {
    const row = await this.core.sql.get(
      "SELECT state, version, expires_at FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
    if (!row) return undefined;
    // `expires_at` defaults to 0 in the schema, and 0 means "never expires"
    // (the sweep skips it) -- surfaced as undefined so the tick refreshes it on
    // sight, matching how a TTL-less DynamoDB row is treated.
    const expiresAt = Number(row.expires_at ?? 0);
    return {
      state: JSON.parse(String(row.state)),
      version: Number(row.version ?? 0),
      expiresAt: expiresAt > 0 ? expiresAt : undefined,
    };
  }

  /**
   * [Issue #3123] See `DeploymentsCoordinationPort.touchCoordinationState`.
   * An `UPDATE` matching no row is a no-op, which is the wanted behaviour for
   * an absent namespace.
   */
  async touchCoordinationState(scope: CoordinationStateScope, expiresAt: number): Promise<void> {
    await this.core.sql.run(
      "UPDATE coordination_state_scoped SET expires_at = ? WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [expiresAt, scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
  }

  /**
   * [Issue #3123] `expires_at` mirrors the DynamoDB row's TTL attribute so the
   * two backends converge on the same retention, even though SQLite has no
   * native TTL — {@link sweepExpiredCoordinationState} is what actually reaps
   * here. Refreshed on every write, so the clock only starts once a match stops
   * being played.
   */
  async writeCoordinationState(
    scope: CoordinationStateScope,
    state: unknown,
    expectedVersion: number,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    const params = [
      scope.tenantId,
      scope.eventId,
      scope.problemId,
      scope.runId,
      JSON.stringify(normalizeJsonValue(state)),
      expectedVersion + 1,
      at,
      expiresAt,
    ];
    // [Issue #3126] Only a first write (expectedVersion 0) may insert. A write
    // carrying a version read earlier must find that row still present — see
    // the DynamoDB adapter for the run-reset race this closes. The plain upsert
    // this replaced inserted whenever the row was absent, whatever version the
    // caller expected, so a pre-reset op could resurrect the deleted match.
    const result =
      expectedVersion === 0
        ? await this.core.sql.run(
            `INSERT INTO coordination_state_scoped (tenant_id, event_id, problem_id, run_id, state, version, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, event_id, problem_id, run_id) DO NOTHING`,
            params,
          )
        : await this.core.sql.run(
            `UPDATE coordination_state_scoped
         SET state = ?, version = ?, updated_at = ?, expires_at = ?
       WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ? AND version = ? AND (json_extract(state, '$.__tenkacloudCoordinationEnvelope') IS NOT 1 OR json_extract(state, '$.pendingScores') IS NULL)`,
            [
              JSON.stringify(normalizeJsonValue(state)),
              expectedVersion + 1,
              at,
              expiresAt,
              scope.tenantId,
              scope.eventId,
              scope.problemId,
              scope.runId,
              expectedVersion,
            ],
          );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "conflict" };
  }

  /**
   * [Issue #3133] See `DeploymentsCoordinationPort.ensureCoordinationMatchSecret`.
   *
   * Read first, mint only when absent, so every op after the first is one
   * SELECT and no write. `INSERT OR IGNORE` still guards the mint because the
   * read is not a lock: on a concurrent first op the insert is a no-op and the
   * read-back adopts the winner's secret, instead of replacing material the
   * winner has already derived from.
   */
  async ensureCoordinationMatchSecret(
    scope: CoordinationStateScope,
    candidate: string,
    expiresAt: number,
  ): Promise<string> {
    const existing = await this.readCoordinationMatchSecret(scope);
    if (existing !== undefined) return existing;
    await this.core.sql.run(
      `INSERT OR IGNORE INTO coordination_match_secret
         (tenant_id, event_id, problem_id, run_id, match_secret, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId, candidate, expiresAt],
    );
    const stored = await this.readCoordinationMatchSecret(scope);
    if (stored !== undefined) return stored;
    // Deleted between the insert and the read (a teardown landing mid-op).
    // Returning `candidate` would hand this op a secret nothing else holds.
    throw new Error("coordination match secret vanished between write and read");
  }

  /** [Issue #3133] See `DeploymentsCoordinationPort.readCoordinationMatchSecret`. */
  async readCoordinationMatchSecret(scope: CoordinationStateScope): Promise<string | undefined> {
    const row = await this.core.sql.get(
      "SELECT match_secret FROM coordination_match_secret WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
    if (!row) return undefined;
    const secret = String(row.match_secret ?? "");
    return secret.length > 0 ? secret : undefined;
  }

  /**
   * [Issue #3123] Deletes exactly this scope's row. Idempotent — a `DELETE`
   * matching nothing is a success, so a retried or half-finished teardown
   * converges rather than erroring.
   *
   * Unlike the DynamoDB adapter there is no separate pre-scope row to clear:
   * the schema migration already folded any legacy row into the reserved
   * `__pre_scope__` namespace, and that namespace has no live scope to be
   * deleted through.
   */
  async deleteCoordinationState(scope: CoordinationStateScope): Promise<void> {
    await this.core.sql.run(
      "DELETE FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
    // [Issue #3133] The secret goes with the match it belongs to, so a
    // re-created scope cannot inherit the deleted match's hidden material.
    await this.core.sql.run(
      "DELETE FROM coordination_match_secret WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
  }

  /**
   * [Issue #3149] See `DeploymentsCoordinationPort.deleteCoordinationStateIfUnchanged`.
   *
   * `version = ?` in the WHERE clause is the whole condition: SQLite reports
   * how many rows the DELETE matched, and zero means the row is either gone or
   * has moved on — both of which are `conflict` from the caller's side.
   *
   * The secret is removed only once the state delete actually matched, for the
   * same reason as on DynamoDB: on a conflict the match is still being played
   * and still deriving from that secret.
   */
  async deleteCoordinationStateIfUnchanged(
    scope: CoordinationStateScope,
    expectedVersion: number,
  ): Promise<DeploymentMutationOutcome> {
    assertConditionableVersion(expectedVersion);
    const result = await this.core.sql.run(
      "DELETE FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ? AND version = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId, expectedVersion],
    );
    if (Number(result.changes) === 0) return { outcome: "conflict" };
    await this.core.sql.run(
      "DELETE FROM coordination_match_secret WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
    return { outcome: "updated" };
  }

  /** [Issue #3153] See `DeploymentsCoordinationPort.readCoordinationRun`. */
  async readCoordinationRun(key: CoordinationRunKey): Promise<CoordinationRunPointer | undefined> {
    const row = await this.core.sql.get(
      "SELECT run_id, started_at, history FROM coordination_run WHERE tenant_id = ? AND event_id = ? AND problem_id = ?",
      [key.tenantId, key.eventId, key.problemId],
    );
    if (!row) return undefined;
    return {
      runId: String(row.run_id ?? ""),
      startedAt: String(row.started_at ?? ""),
      history: parseRunHistory(row.history),
    };
  }

  /**
   * [Issue #3153] See `DeploymentsCoordinationPort.rotateCoordinationRun`.
   *
   * Two statements rather than one upsert, because the condition differs by
   * case and SQLite cannot express both in a single `ON CONFLICT`. Rotating
   * away from the initial run must succeed whether or not a row exists —
   * "no pointer" and "a pointer naming the default" mean the same thing — so it
   * tries the conditional UPDATE first and falls back to an insert that only
   * lands when nothing is there.
   */
  async rotateCoordinationRun(
    key: CoordinationRunKey,
    expectedRunId: string,
    pointer: CoordinationRunPointer,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    const updated = await this.core.sql.run(
      `UPDATE coordination_run
         SET run_id = ?, started_at = ?, history = ?, expires_at = ?
       WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?`,
      [
        pointer.runId,
        pointer.startedAt,
        JSON.stringify(pointer.history),
        expiresAt,
        key.tenantId,
        key.eventId,
        key.problemId,
        expectedRunId,
      ],
    );
    if (Number(updated.changes) > 0) return { outcome: "updated" };
    if (expectedRunId !== DEFAULT_COORDINATION_RUN_ID) return { outcome: "conflict" };
    const inserted = await this.core.sql.run(
      `INSERT INTO coordination_run (tenant_id, event_id, problem_id, run_id, started_at, history, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, event_id, problem_id) DO NOTHING`,
      [
        key.tenantId,
        key.eventId,
        key.problemId,
        pointer.runId,
        pointer.startedAt,
        JSON.stringify(pointer.history),
        expiresAt,
      ],
    );
    return Number(inserted.changes) > 0 ? { outcome: "updated" } : { outcome: "conflict" };
  }

  /** [Issue #3153] See `DeploymentsCoordinationPort.deleteCoordinationRun`. */
  async deleteCoordinationRun(key: CoordinationRunKey): Promise<void> {
    await this.core.sql.run(
      "DELETE FROM coordination_run WHERE tenant_id = ? AND event_id = ? AND problem_id = ?",
      [key.tenantId, key.eventId, key.problemId],
    );
  }

  /**
   * [Issue #3123] The retention primitive for rows no teardown ever deleted.
   * `expires_at > 0` skips rows written without a TTL (the migrated
   * `__pre_scope__` rows), the same guard the disruptions repository's sweep
   * uses.
   *
   * [Issue #3127] Driven by the generic-scoring reconciler's per-minute prune
   * tick, which is gated on the pure-SQL backend — DynamoDB reaps `expiresAt`
   * natively and must not pay for a Scan that deletes what the table already
   * deletes.
   */
  async sweepExpiredCoordinationState(nowEpochSeconds: number): Promise<number> {
    const result = await this.core.sql.run(
      "DELETE FROM coordination_state_scoped WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    // [Issue #3133] Secrets expire on the same clock as the state they belong
    // to. Counted separately would double-count one match, so only the state
    // rows are reported — the count is "matches reaped", not "rows deleted".
    await this.core.sql.run(
      "DELETE FROM coordination_match_secret WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}

/**
 * Reads the stored history column back.
 *
 * A row whose JSON will not parse is treated as having no history rather than
 * failing the read: the pointer's job is to say which run is CURRENT, and
 * refusing to answer that because a decorative list is corrupt would take a
 * live match down over nothing.
 */
function parseRunHistory(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
