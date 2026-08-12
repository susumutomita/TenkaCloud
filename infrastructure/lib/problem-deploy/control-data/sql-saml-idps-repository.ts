import type { IdpScope } from "../../control-plane/handlers/idp-handler/core.js";
import type { SamlIdpRecord, SamlIdpsRepository, SqlExecutor } from "./types.js";

/**
 * [Issue #2442 / Phase C5] SQLite schema for the SamlIdps aggregate. One SQL
 * layer in the SQLite dialect targets the Turso (libSQL) hosted backend
 * (#2677: Turso-only).
 *
 * `scope_key` mirrors the DynamoDB physical `pk` (`SYSTEM` | tenantId); `idp_id`
 * mirrors `sk`. The full record is additionally stored as a JSON `payload` so
 * new `SamlIdpConfig` attributes round-trip without a migration — the same
 * "denormalized columns for the query path, payload for everything else" split
 * {@link SqlProblemEndpointsRepository} uses.
 */
export const SAML_IDPS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS saml_idps (
  scope_key TEXT NOT NULL,
  idp_id    TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (scope_key, idp_id)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const SAML_IDPS_SCHEMA_SQL = `${SAML_IDPS_SCHEMA_STATEMENTS.join(";\n")};`;

function scopeKey(scope: IdpScope): string {
  return scope.kind === "system" ? "SYSTEM" : scope.tenantId;
}

function rowToRecord(payload: unknown): SamlIdpRecord {
  return JSON.parse(String(payload)) as SamlIdpRecord;
}

/**
 * [Issue #2442 / Phase C5] SQLite implementation of {@link SamlIdpsRepository}.
 * No conditional writes, no Scan — every method maps to exactly one statement
 * (mirrors {@link SqlProblemEndpointsRepository}).
 */
export class SqlSamlIdpsRepository implements SamlIdpsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async list(scope: IdpScope): Promise<readonly SamlIdpRecord[]> {
    const rows = await this.sql.all(
      // idp_id 昇順で決定的な順序にする (DDB base-table SK 昇順の鏡像。ドメイン上の意味は無いが
      // backend 間で安定した順序にしておくと byte-pin テストが書きやすい)。
      "SELECT payload FROM saml_idps WHERE scope_key = ? ORDER BY idp_id ASC",
      [scopeKey(scope)],
    );
    return rows.map((row) => rowToRecord(row.payload));
  }

  async get(scope: IdpScope, idpId: string): Promise<SamlIdpRecord | null> {
    const row = await this.sql.get(
      "SELECT payload FROM saml_idps WHERE scope_key = ? AND idp_id = ?",
      [scopeKey(scope), idpId],
    );
    return row ? rowToRecord(row.payload) : null;
  }

  async put(scope: IdpScope, config: SamlIdpRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO saml_idps (scope_key, idp_id, payload)
       VALUES (?, ?, ?)
       ON CONFLICT(scope_key, idp_id) DO UPDATE SET payload = excluded.payload`,
      [scopeKey(scope), config.idpId, JSON.stringify(config)],
    );
  }

  async delete(scope: IdpScope, idpId: string): Promise<void> {
    await this.sql.run("DELETE FROM saml_idps WHERE scope_key = ? AND idp_id = ?", [
      scopeKey(scope),
      idpId,
    ]);
  }
}
