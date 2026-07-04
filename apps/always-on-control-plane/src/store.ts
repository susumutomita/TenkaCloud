import { generateBearerToken, sha256Hex } from "./crypto.js";

export interface EventInput {
  readonly name: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export interface CheckpointInput {
  readonly problemId: string;
  readonly checkpointId: string;
  readonly flag: string;
  readonly points: number;
}

export class ControlStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Onboard (or update) the Auth0 Organization → tenant mapping the organizer auth path
   * reads on every request. `suspended` also drives instant revocation.
   */
  async upsertTenantAuthProjection(input: {
    readonly orgId: string;
    readonly tenantId: string;
    readonly suspended: boolean;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           suspended = excluded.suspended,
           updated_at = excluded.updated_at`,
      )
      .bind(input.orgId, input.tenantId, input.suspended ? 1 : 0, new Date().toISOString())
      .run();
  }

  async listEvents(tenantId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db
      .prepare(
        `SELECT event_id AS eventId, name, status, starts_at AS startsAt,
                ends_at AS endsAt, created_at AS createdAt, updated_at AS updatedAt
           FROM events
          WHERE tenant_id = ?
          ORDER BY created_at DESC, event_id DESC`,
      )
      .bind(tenantId)
      .all();
    return result.results;
  }

  async createEvent(
    tenantId: string,
    input: EventInput,
  ): Promise<{ readonly eventId: string; readonly status: string }> {
    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO events (
          event_id, tenant_id, name, status, starts_at, ends_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      )
      .bind(eventId, tenantId, input.name, input.startsAt ?? null, input.endsAt ?? null, now, now)
      .run();
    return { eventId, status: "DRAFT" };
  }

  async createTeam(
    tenantId: string,
    eventId: string,
    displayName: string,
  ): Promise<{ readonly teamId: string; readonly loginKey: string }> {
    const teamId = crypto.randomUUID();
    const loginKey = generateBearerToken();
    const loginKeyHash = await sha256Hex(loginKey);
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO teams (
          team_id, event_id, tenant_id, display_name, login_key_hash, created_at
        )
        SELECT ?, event_id, tenant_id, ?, ?, ?
          FROM events
         WHERE event_id = ? AND tenant_id = ?`,
      )
      .bind(teamId, displayName, loginKeyHash, now, eventId, tenantId)
      .run();
    if (result.meta.changes === 0) throw new Error("event not found");
    return { teamId, loginKey };
  }

  async hasTeam(tenantId: string, eventId: string, teamId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM teams WHERE team_id = ? AND event_id = ? AND tenant_id = ?",
      )
      .bind(teamId, eventId, tenantId)
      .first<{ present: number }>();
    return row !== null;
  }

  async putCheckpoint(tenantId: string, eventId: string, input: CheckpointInput): Promise<void> {
    const flagHash = await sha256Hex(input.flag);
    const result = await this.db
      .prepare(
        `INSERT INTO challenge_checkpoints (
          event_id, problem_id, checkpoint_id, flag_hash, points
        )
        SELECT event_id, ?, ?, ?, ?
          FROM events
         WHERE event_id = ? AND tenant_id = ?
        ON CONFLICT(event_id, problem_id, checkpoint_id) DO UPDATE SET
          flag_hash = excluded.flag_hash,
          points = excluded.points`,
      )
      .bind(input.problemId, input.checkpointId, flagHash, input.points, eventId, tenantId)
      .run();
    if (result.meta.changes === 0) throw new Error("event not found");
  }

  async submitCheckpoint(input: {
    readonly teamId: string;
    readonly eventId: string;
    readonly problemId: string;
    readonly checkpointId: string;
    readonly flag: string;
  }): Promise<"incorrect" | "solved" | "already_solved"> {
    const flagHash = await sha256Hex(input.flag);
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO submissions (
          event_id, team_id, problem_id, checkpoint_id, awarded_points, submitted_at
        )
        SELECT event_id, ?, problem_id, checkpoint_id, points, ?
          FROM challenge_checkpoints
         WHERE event_id = ?
           AND problem_id = ?
           AND checkpoint_id = ?
           AND flag_hash = ?`,
      )
      .bind(
        input.teamId,
        new Date().toISOString(),
        input.eventId,
        input.problemId,
        input.checkpointId,
        flagHash,
      )
      .run();
    // D1 counts rows changed by the materialization trigger as well as the
    // submission row, so a successful first solve can report more than one.
    if (result.meta.changes > 0) return "solved";
    const alreadySolved = await this.db
      .prepare(
        `SELECT 1 AS solved
           FROM submissions
          WHERE event_id = ? AND team_id = ? AND problem_id = ? AND checkpoint_id = ?`,
      )
      .bind(input.eventId, input.teamId, input.problemId, input.checkpointId)
      .first<{ solved: number }>();
    return alreadySolved ? "already_solved" : "incorrect";
  }

  /**
   * Upsert an event runtime's uptime-score contribution for a team (ADR-049 Phase 5 / #2294).
   * The AWS event runtime pushes the authoritative uptime points; the leaderboard sums them
   * with the flag-materialized `score_summary`.
   */
  async upsertRuntimeScore(input: {
    readonly eventId: string;
    readonly teamId: string;
    readonly points: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runtime_score (event_id, team_id, points, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id, team_id) DO UPDATE SET
           points = excluded.points,
           updated_at = excluded.updated_at`,
      )
      .bind(input.eventId, input.teamId, input.points, new Date().toISOString())
      .run();
  }

  async leaderboard(eventId: string): Promise<readonly Record<string, unknown>[]> {
    // Every team has a score_summary row (the AFTER-INSERT-ON-teams trigger seeds it at 0), so
    // start FROM score_summary (each team appears once) and LEFT JOIN the uptime contribution.
    // The displayed score sums the flag-materialized score_summary.score with runtime_score.points;
    // when runtime_score is empty this reduces to the flag-only leaderboard (backward compatible).
    const result = await this.db
      .prepare(
        `SELECT summary.team_id AS teamId,
                team.display_name AS displayName,
                summary.score + COALESCE(runtime.points, 0) AS score,
                summary.solved_checkpoints AS solvedCheckpoints,
                MAX(summary.updated_at, COALESCE(runtime.updated_at, '')) AS updatedAt
           FROM score_summary AS summary
           JOIN teams AS team ON team.team_id = summary.team_id
           LEFT JOIN runtime_score AS runtime
                  ON runtime.team_id = summary.team_id AND runtime.event_id = summary.event_id
          WHERE summary.event_id = ?
          ORDER BY score DESC, updatedAt ASC, summary.team_id ASC`,
      )
      .bind(eventId)
      .all();
    return result.results;
  }
}
