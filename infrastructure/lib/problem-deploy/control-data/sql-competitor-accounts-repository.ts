import type { CompetitorAccountItem } from "../handlers/competitor-accounts-handler/types.js";
import type {
  CompetitorAccountMutationOutcome,
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
  CreateCompetitorAccountOutcome,
  SqlExecutor,
} from "./types.js";

/**
 * [Issue #2442 / Phase C2] SQLite schema for the CompetitorAccounts aggregate.
 * One SQL layer in the SQLite dialect targets the Turso (libSQL) hosted
 * backend (#2677: Turso-only).
 *
 * Denormalized `tenant_id` / `aws_account_id` columns mirror the DynamoDB
 * physical PK/SK (`TENANT#<t>` / `ACCOUNT#<a>`) so `listAccounts` /
 * `getAccount` / `hasRemainingAccounts` stay indexed lookups; the full record
 * is additionally stored as a JSON `payload` so new attributes round-trip
 * without a migration (the same split {@link SqlProblemEndpointsRepository}
 * uses).
 */
export const COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS competitor_accounts (
  tenant_id      TEXT NOT NULL,
  aws_account_id TEXT NOT NULL,
  payload        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, aws_account_id)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const COMPETITOR_ACCOUNTS_SCHEMA_SQL = `${COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS.join(";\n")};`;

/**
 * SQLite dialect uniqueness-violation detector, covering both drivers we run
 * on: `node:sqlite` ("UNIQUE constraint failed: …") and `@libsql/client`
 * (`LibsqlError` carries `code = "SQLITE_CONSTRAINT"` with the specific
 * `SQLITE_CONSTRAINT_PRIMARYKEY` / `_UNIQUE` value on `extendedCode`).
 * Deliberately narrow: only PRIMARY KEY / UNIQUE violations convert to
 * `conflict` — other constraint classes (NOT NULL / CHECK / FK) signal a data
 * bug and must keep failing loudly. Duplicated from
 * `sql-events-repository.ts` / `sql-deployments-repository.ts` (this
 * codebase's established per-aggregate-file convention — the helper is not
 * shared across aggregate files).
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

function rowToRecord(payload: unknown): CompetitorAccountRecord {
  return JSON.parse(String(payload)) as CompetitorAccountRecord;
}

/**
 * [Issue #2442 / Phase C2] SQLite implementation of {@link CompetitorAccountsRepository}.
 */
export class SqlCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async createAccount(record: CompetitorAccountRecord): Promise<CreateCompetitorAccountOutcome> {
    try {
      await this.sql.run(
        "INSERT INTO competitor_accounts (tenant_id, aws_account_id, payload) VALUES (?, ?, ?)",
        [record.tenantId, record.awsAccountId, JSON.stringify(record)],
      );
      return { outcome: "created" };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  async listAccounts(tenantId: string): Promise<readonly CompetitorAccountRecord[]> {
    const rows = await this.sql.all(
      "SELECT payload FROM competitor_accounts WHERE tenant_id = ? ORDER BY aws_account_id ASC",
      [tenantId],
    );
    return rows.map((row) => rowToRecord(row.payload));
  }

  async getAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountRecord | undefined> {
    const row = await this.sql.get(
      "SELECT payload FROM competitor_accounts WHERE tenant_id = ? AND aws_account_id = ?",
      [tenantId, awsAccountId],
    );
    return row ? rowToRecord(row.payload) : undefined;
  }

  async markVerified(
    tenantId: string,
    awsAccountId: string,
    verifiedAt: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const rows = await this.sql.all(
      `UPDATE competitor_accounts
       SET payload = json_set(payload, '$.verified', json('true'), '$.verifiedAt', ?, '$.updatedAt', ?)
       WHERE tenant_id = ? AND aws_account_id = ?
       RETURNING payload`,
      [verifiedAt, verifiedAt, tenantId, awsAccountId],
    );
    const row = rows[0];
    if (!row) return { outcome: "not_found" };
    return { outcome: "updated", record: rowToRecord(row.payload) };
  }

  async deleteAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const result = await this.sql.run(
      "DELETE FROM competitor_accounts WHERE tenant_id = ? AND aws_account_id = ?",
      [tenantId, awsAccountId],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "not_found" };
  }

  async hasRemainingAccounts(tenantId: string): Promise<boolean> {
    const row = await this.sql.get(
      "SELECT 1 as present FROM competitor_accounts WHERE tenant_id = ? LIMIT 1",
      [tenantId],
    );
    return row !== undefined;
  }

  async forEachCompetitorAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountItem>[]) => Promise<void>,
  ): Promise<void> {
    // MVP scale (~150 accounts) fits in one page; the callback shape is kept
    // for parity with the DynamoDB backend's multi-page Scan contract (same
    // "one page = all rows" precedent as every other SQL `forEach*Page`
    // implementation in this repository — see `SqlDeploymentsRepository`).
    const rows = await this.sql.all(
      "SELECT payload FROM competitor_accounts ORDER BY tenant_id ASC, aws_account_id ASC",
    );
    const items = rows.map((row) => {
      const record = rowToRecord(row.payload);
      return {
        tenantId: record.tenantId,
        awsAccountId: record.awsAccountId,
        rotatedAt: record.rotatedAt,
        createdAt: record.createdAt,
      } satisfies Partial<CompetitorAccountItem>;
    });
    await onPage(items);
  }
}
