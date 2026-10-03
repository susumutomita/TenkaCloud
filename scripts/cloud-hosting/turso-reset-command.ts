import {
  knownTursoDataTables,
  LITE_TURSO_DATA_TABLES,
  LITE_TURSO_TABLE_COLUMNS,
  resetKnownTursoData,
  type TursoDataScope,
  type TursoResetSql,
  type TursoResetTarget,
  type TursoSchema,
  withTursoControlData,
} from "./turso-reset";
import { assertTursoSchemaCompatible, PUBLISHED_CLOUD_DATA_TABLES } from "./turso-schema";

export interface SelectedTursoResetTarget extends Omit<TursoResetTarget, "schema"> {
  readonly environment: string;
  readonly account: string;
}
export interface TursoResetOptions {
  readonly plan: boolean;
  readonly yes: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly output: (message: string) => void;
}
interface ResetInventory {
  readonly schema: TursoSchema;
  readonly tables: readonly string[];
  readonly deployments: number;
}
const UNKNOWN_SCHEMA =
  "Unknown or ambiguous Turso schema; operation stopped before mutation. Select one original/restored Lite database or one published cloud-v1 database.";
const CLOUD_CORE_COLUMNS = new Map([
  ["cloud_schema", ["id", "version"]],
  ["cloud_transaction_guard", ["id", "valid"]],
  ["cloud_events", ["event_id", "payload"]],
  ["cloud_teams", ["event_id", "team_id", "payload"]],
  ["cloud_deployments", ["job_id", "event_id", "team_id", "problem_id", "payload"]],
]);

function metadataName(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(UNKNOWN_SCHEMA);
  return value;
}
async function checkColumns(
  client: TursoResetSql,
  columns: ReadonlyMap<string, readonly string[]>,
  tables: ReadonlySet<string>,
): Promise<void> {
  try {
    for (const [name, fields] of columns) {
      if (tables.has(name))
        // Both names and columns come from source contracts, never database input.
        await client.execute(`SELECT ${fields.join(", ")} FROM "${name}" LIMIT 0`);
    }
  } catch {
    throw new Error(UNKNOWN_SCHEMA);
  }
}
async function selectSchema(
  client: TursoResetSql,
  tables: ReadonlySet<string>,
): Promise<TursoSchema> {
  if (LITE_TURSO_DATA_TABLES.some((name) => tables.has(name))) {
    if (!["events", "teams", "deployments"].every((name) => tables.has(name)))
      throw new Error(UNKNOWN_SCHEMA);
    // A previously purged, known-empty cloud-v1 schema may coexist with restored Lite.
    // Nonempty retired data or unrecognized cloud tables cannot be silently adopted.
    await assertTursoSchemaCompatible(client);
    await checkColumns(client, LITE_TURSO_TABLE_COLUMNS, tables);
    return "lite-baseline-v1";
  }
  const known = new Set<string>(["cloud_schema", ...PUBLISHED_CLOUD_DATA_TABLES]);
  if (
    ![...CLOUD_CORE_COLUMNS.keys()].every((name) => tables.has(name)) ||
    [...tables].some((name) => name.startsWith("cloud_") && !known.has(name))
  )
    throw new Error(UNKNOWN_SCHEMA);
  await checkColumns(client, CLOUD_CORE_COLUMNS, tables);
  const guard = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cloud_transaction_guard'",
  );
  const definition = guard.rows[0]?.sql;
  if (typeof definition !== "string" || !/CHECK\s*\(\s*valid\s*=\s*1\s*\)/iu.test(definition))
    throw new Error(UNKNOWN_SCHEMA);
  const version = await client.execute("SELECT id, version FROM cloud_schema");
  if (version.rows.length !== 1 || version.rows[0]?.id !== 1 || version.rows[0]?.version !== 1)
    throw new Error(UNKNOWN_SCHEMA);
  return "cloud-v1";
}
async function guardUnrelatedData(client: TursoResetSql, owned: readonly string[]): Promise<void> {
  const triggers = await client.execute(
    "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger'",
  );
  if (triggers.rows.some((row) => owned.includes(metadataName(row, "tbl_name"))))
    throw new Error(
      "Selected tables have custom triggers; their effects cannot be proven safe. No rows were deleted.",
    );
  const references = await client.execute(
    "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f WHERE m.type = 'table'",
  );
  if (
    references.rows.some(
      (row) =>
        owned.includes(metadataName(row, "parent")) && !owned.includes(metadataName(row, "child")),
    )
  )
    throw new Error(
      "Unrelated tables reference selected tables; operation stopped to preserve their data. No rows were deleted.",
    );
}
async function inspectReset(client: TursoResetSql, scope: TursoDataScope): Promise<ResetInventory> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const names = new Set(result.rows.map((row) => metadataName(row, "name")));
  const schema = await selectSchema(client, names);
  const tables = knownTursoDataTables(schema, scope).filter((name) => names.has(name));
  // The cloud-v1 write batch also refreshes its transaction guard; inspect its side effects.
  const writtenTables =
    schema === "cloud-v1" ? [...new Set([...tables, "cloud_transaction_guard"])] : tables;
  await guardUnrelatedData(client, writtenTables);
  const deploymentTable = schema === "cloud-v1" ? "cloud_deployments" : "deployments";
  const count = await client.execute(`SELECT COUNT(*) AS count FROM "${deploymentTable}"`);
  const value = count.rows[0]?.count;
  const numeric =
    typeof value === "number" ||
    typeof value === "bigint" ||
    (typeof value === "string" && /^\d+$/u.test(value));
  const deployments = numeric ? Number(value) : Number.NaN;
  if (count.rows.length !== 1 || !Number.isSafeInteger(deployments) || deployments < 0)
    throw new Error("Deployment count could not be verified; no rows were deleted.");
  return { schema, tables, deployments };
}

/** Standalone recovery explicitly targets the selected configuration, without stack discovery. */
export async function resetSelectedTursoData(
  target: SelectedTursoResetTarget,
  options: TursoResetOptions,
  connect = withTursoControlData,
): Promise<void> {
  options.output(
    `[cloud] Turso reset target: environment ${target.environment}, AWS account ${target.account}, region ${target.region}\nDatabase: ${target.databaseUrl}\nSSM SecureString: ${target.parameterName}\n`,
  );
  await connect(target, async (client) => {
    await clearTursoControlData(client, options);
  });
}

/** Share the same schema, inventory, confirmation and transaction guards across credentials. */
export async function clearTursoControlData(
  client: TursoResetSql,
  options: TursoResetOptions,
  scope: TursoDataScope = "all",
): Promise<void> {
  const operation = scope === "competition" ? "clear" : "reset";
  const inventory = await inspectReset(client, scope);
  options.output(
    `Schema: ${inventory.schema}\nDelete all rows in ${inventory.tables.length} known tables: ${inventory.tables.join(", ")}\nPreserve table definitions, migration/schema markers and unrelated tables. Stop all application writers before proceeding. This does not remove AWS stacks or exercise resources.\n`,
  );
  options.output(
    `Remaining deployment records: ${inventory.deployments}. Deleting these records can orphan exercise resources that still exist in competitor accounts. Complete exercise Teardown before proceeding.\n`,
  );
  if (scope === "competition")
    options.output(
      "Preserve installation accounts, authentication/connection settings, feature flags, admin audit and migration state. This clears competition data only.\n",
    );
  if (options.plan) return;
  if (
    !options.yes &&
    !(await options.confirm(
      scope === "competition"
        ? "Permanently clear these Turso competition-data rows? [y/N] "
        : "Permanently delete these Turso control-data rows? [y/N] ",
    ))
  )
    throw new Error(
      `Turso ${operation} cancelled; no rows were deleted. Noninteractive execution requires --yes.`,
    );
  const current = await inspectReset(client, scope);
  if (JSON.stringify(current) !== JSON.stringify(inventory))
    throw new Error(
      "Turso schema or deployment count changed during confirmation; no rows were deleted. Stop writers and review the target again.",
    );
  try {
    await resetKnownTursoData(client, inventory.schema, scope);
  } catch {
    throw new Error(
      `Turso ${operation} did not complete successfully. SQL failures roll back the write batch; a lost response can leave its commit outcome unknown. Inspect the selected database before retrying. No success was assumed.`,
    );
  }
  options.output(
    scope === "competition"
      ? "Turso competition-data clear completed; schema, configuration, migration state and unrelated tables were preserved.\n"
      : "Turso control-data reset completed; schema, migration state and unrelated tables were preserved.\n",
  );
}
