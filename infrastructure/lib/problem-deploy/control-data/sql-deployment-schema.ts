/** Installation-scoped deployment workflow state. Immutable attempt and generation identities are explicit keys. */
export const DEPLOYMENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_connections (event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (event_id, team_id))`,
  `CREATE TABLE IF NOT EXISTS cloud_deployment_targets (event_id TEXT NOT NULL, team_id TEXT NOT NULL, problem_id TEXT NOT NULL, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY (event_id, team_id, problem_id))`,
  `CREATE TABLE IF NOT EXISTS cloud_deployment_receipts (receipt_key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cloud_dispatch (job_id TEXT NOT NULL, attempt INTEGER NOT NULL, operation TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (job_id, attempt, operation, generation))`,
  `CREATE INDEX IF NOT EXISTS cloud_dispatch_operation ON cloud_dispatch(operation, job_id, attempt, generation)`,
  `CREATE TABLE IF NOT EXISTS cloud_creations (job_id TEXT NOT NULL, attempt INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (job_id, attempt))`,
  `CREATE TABLE IF NOT EXISTS cloud_deployment_attempts (job_id TEXT NOT NULL, attempt INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (job_id, attempt))`,
  `CREATE TABLE IF NOT EXISTS cloud_teardowns (job_id TEXT NOT NULL, source_attempt INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (job_id, source_attempt))`,
  `CREATE TABLE IF NOT EXISTS cloud_score_events (job_id TEXT NOT NULL, request_hash TEXT NOT NULL, event_id TEXT NOT NULL, team_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (job_id, request_hash))`,
  `CREATE INDEX IF NOT EXISTS cloud_score_events_team ON cloud_score_events (event_id, team_id, occurred_at DESC, request_hash DESC)`,
] as const;
