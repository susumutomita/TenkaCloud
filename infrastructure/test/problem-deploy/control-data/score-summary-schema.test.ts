import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCORE_SUMMARY_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/score-summary-schema.js";

describe("score summary SQLite schema", () => {
  it("should materialize deterministic leaderboard rows and a one-row event snapshot", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCORE_SUMMARY_SCHEMA_SQL);
    const putSummary = db.prepare(
      `INSERT INTO score_summary (
         event_id, team_id, score, solved_checkpoints, updated_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    putSummary.run("event-1", "team-b", 20, 2, "2026-07-04T00:00:01.000Z", '{"team":"b"}');
    putSummary.run("event-1", "team-a", 20, 1, "2026-07-04T00:00:00.000Z", '{"team":"a"}');

    expect(
      db
        .prepare(
          `SELECT team_id FROM score_summary
           WHERE event_id = ?
           ORDER BY score DESC, updated_at ASC, team_id ASC`,
        )
        .all("event-1"),
    ).toEqual([{ team_id: "team-a" }, { team_id: "team-b" }]);

    db.prepare(
      `INSERT INTO leaderboard_snapshots (event_id, generated_at, payload)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         generated_at = excluded.generated_at,
         payload = excluded.payload`,
    ).run("event-1", "2026-07-04T00:00:30.000Z", '[{"teamId":"team-a","score":20}]');
    expect(
      db.prepare("SELECT payload FROM leaderboard_snapshots WHERE event_id = ?").get("event-1"),
    ).toEqual({ payload: '[{"teamId":"team-a","score":20}]' });
  });
});
