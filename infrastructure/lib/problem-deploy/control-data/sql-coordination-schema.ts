import { coordinationHeadKey } from "./domain/coordination.js";
import type { SqlStatement } from "./sql-port.js";
import { sqlGuard } from "./sql-transaction.js";

/** One SQL row is an atomic native snapshot; no DynamoDB item chunking is needed. */
export const SQL_COORDINATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cloud_coordination_runs (
    event_id TEXT NOT NULL, problem_id TEXT NOT NULL, payload TEXT NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY (event_id, problem_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_coordination_receipts (
    event_id TEXT NOT NULL, problem_id TEXT NOT NULL, run_id TEXT NOT NULL,
    team_id TEXT NOT NULL, operation_hash TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY (event_id, problem_id, run_id, team_id, operation_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_coordination_scores (
    event_id TEXT NOT NULL, problem_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (event_id, problem_id, revision)
  )`,
] as const;

/** Archive only a settled native run. Cleanup uses closeFence for full integrity validation. */
export function sqlCoordinationClosedGuard(eventId: string, problemId: string): SqlStatement {
  coordinationHeadKey(eventId, problemId);
  return sqlGuard(
    `NOT EXISTS (
    SELECT 1 FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?
    AND NOT COALESCE(json_extract(payload, '$.closed') = 1
      AND json_extract(payload, '$.snapshotDigest') IS NOT NULL
      AND json_extract(payload, '$.revision') IS NOT NULL
      AND json_extract(payload, '$.byteLength') > 0, 0)
  )`,
    [eventId, problemId],
  );
}
