/**
 * [Issue #2527 Slice 1] SQL backend port — the injected executor contract. Not a
 * domain module: this is the adapter-facing seam the SQL repositories are built on.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/** Positional bind parameter accepted by {@link SqlExecutor}. */
export type SqlParam = string | number | bigint | null;
/** One result row, keyed by column name. */
export type SqlRow = Record<string, unknown>;
/** Result of a mutating statement (`INSERT` / `UPDATE` / `DELETE`). */
export interface SqlRunResult {
  readonly changes: number | bigint;
}
/** One parameterized statement for {@link SqlExecutor.batch}. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
}

/**
 * Minimal injected SQL driver so {@link SqlEventsRepository} stays
 * decoupled from any concrete client. Node's built-in `node:sqlite`
 * (`DatabaseSync`) backs it for tests and offline validation; the production
 * adapter is the HTTP-only `@libsql/client` (Turso) wired in
 * `runtime-repositories.ts`. (#2677: Turso-only.)
 *
 * [Issue #2437] Contract notes:
 * - `all()` accepts `UPDATE … RETURNING` statements — a conditional update and
 *   its post-image (ALL_NEW equivalent) must be one statement; an update
 *   followed by a re-read opens a race window and is forbidden.
 * - `batch()` runs the statements in a **single write transaction**
 *   (all-or-nothing). A constraint violation on any statement rolls the whole
 *   batch back and rethrows the driver error.
 */
export interface SqlExecutor {
  run(sql: string, params?: readonly SqlParam[]): SqlRunResult | Promise<SqlRunResult>;
  get(sql: string, params?: readonly SqlParam[]): SqlRow | undefined | Promise<SqlRow | undefined>;
  all(sql: string, params?: readonly SqlParam[]): readonly SqlRow[] | Promise<readonly SqlRow[]>;
  batch(
    statements: readonly SqlStatement[],
  ): readonly SqlRunResult[] | Promise<readonly SqlRunResult[]>;
}
