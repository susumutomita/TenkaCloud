/** Installation-scoped registry and retained references; no credentials are stored here. */
export const COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_competitor_accounts (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cloud_competitor_references (
    account_id TEXT NOT NULL, event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (account_id, event_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_external_id (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`,
] as const;
