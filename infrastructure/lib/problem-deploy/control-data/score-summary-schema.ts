/**
 * SQL schema for the materialized scoring projection.
 *
 * One row per team keeps the leaderboard query bounded to the event's team
 * count. The JSON snapshot is regenerated at most once per polling interval, so
 * participant polling reads one row instead of scanning all team summaries.
 * Raw score events stay in the event-runtime DynamoDB table.
 */
export const SCORE_SUMMARY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS score_summary (
  event_id           TEXT    NOT NULL,
  team_id            TEXT    NOT NULL,
  score              INTEGER NOT NULL DEFAULT 0,
  solved_checkpoints INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT    NOT NULL,
  payload            TEXT    NOT NULL,
  PRIMARY KEY (event_id, team_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_score_summary_leaderboard
  ON score_summary (event_id, score DESC, updated_at ASC, team_id ASC)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  event_id     TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  payload      TEXT NOT NULL
)`,
] as const;

/** SQL script form for local SQLite verification and manual bootstrap. */
export const SCORE_SUMMARY_SCHEMA_SQL = `${SCORE_SUMMARY_SCHEMA_STATEMENTS.join(";\n")};`;
