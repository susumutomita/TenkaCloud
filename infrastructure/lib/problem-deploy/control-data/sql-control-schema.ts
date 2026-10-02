import { COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS } from "./sql-competitor-accounts-schema.js";
import { SQL_COORDINATION_SCHEMA } from "./sql-coordination-schema.js";
import { DEPLOYMENT_SCHEMA_STATEMENTS } from "./sql-deployment-schema.js";

/** Current cloud hosting records only. This is not the historical Lite/SaaS schema. */
export const SQL_SCHEMA_VERSION = 1;
export const CONTROL_DATA_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
  `INSERT INTO cloud_schema (id, version) VALUES (1, ${SQL_SCHEMA_VERSION}) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS cloud_transaction_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    valid INTEGER NOT NULL CONSTRAINT cloud_cas_guard CHECK (valid = 1)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS cloud_events_created ON cloud_events (json_extract(payload, '$.createdAt'), event_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_teams (
    event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (event_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_access_keys (
    key_hash TEXT PRIMARY KEY, event_id TEXT NOT NULL, team_id TEXT NOT NULL, auth_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_create_receipts (receipt_hash TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cloud_deployments (
    job_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, team_id TEXT NOT NULL, problem_id TEXT NOT NULL, payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_deployments_event_team ON cloud_deployments (event_id, team_id, problem_id, job_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_team_scores (
    event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (event_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_installation_control (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`,
  ...DEPLOYMENT_SCHEMA_STATEMENTS,
  ...COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS,
  ...SQL_COORDINATION_SCHEMA,
] as const;
