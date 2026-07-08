#!/usr/bin/env bun
/**
 * Issue #2444 (Relates #2435): post-destroy RETAIN table leftover warning.
 *
 * Every TenkaCloud DynamoDB table is `RemovalPolicy.RETAIN` (intentional — we keep
 * event / scoring history across re-deploys). So `make destroy` / `make destroy-saas`
 * tear the stacks down but the tables **survive and keep billing** their provisioned
 * capacity. On a post-2025 Free Tier account there is no 25 RCU/WCU always-free grant,
 * so this is real standing cost the operator cannot see. #2435 measured 2026-06 at 37
 * unit pairs continuously provisioned ($7.06 that month) — orphans accumulated across
 * repeated deploy/destroy cycles precisely because nothing surfaced them.
 *
 * This module runs at the tail of both destroy paths and, if TenkaCloud-owned tables
 * remain, prints:
 *   - the table names + their provisioned RCU/WCU (base table + every GSI),
 *   - an **estimated** monthly cost (clearly labelled), and
 *   - the exact `aws dynamodb delete-table` command per table.
 *
 * It NEVER deletes anything (RETAIN is intentional; deletion is the operator's explicit
 * choice) and it degrades gracefully: a missing / expired credential or a denied
 * `dynamodb:ListTables` prints a single-line notice and returns without changing the
 * destroy exit code. Detection is by physical-name prefix — every TenkaCloud stack id is
 * `tenkacloud-*` (see `lib/app-wiring/wire.ts` + `lib/tenkacloud-lite/stack-names.ts`),
 * and CloudFormation auto-names these tables `<stackName>-<logicalId>-<hash>`, so they
 * all start with `tenkacloud-`.
 *
 * Pure + injectable: `warnRetainedTables(io)` takes an `aws` runner + stdout/stderr, so
 * unit tests observe the output with a mocked DynamoDB client and no real AWS calls.
 */

import { spawn } from "node:child_process";

export interface AwsRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the `aws` CLI with the given argument list. Injected so tests never hit AWS. */
export type AwsRunner = (args: readonly string[]) => Promise<AwsRunResult>;

export interface RetainWarningIo {
  readonly aws: AwsRunner;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Physical-name prefix shared by every TenkaCloud stack (and therefore every
 * CloudFormation-auto-named table inside those stacks). Case-insensitive match keeps us
 * robust to any future casing drift while still ignoring unrelated tables.
 */
export const TENKACLOUD_TABLE_PREFIX = "tenkacloud-";

/**
 * ap-northeast-1 (Tokyo) DynamoDB **provisioned** list price. Derived from the us-east-1
 * baseline (RCU $0.00013/h, WCU $0.00065/h) scaled by the ~1.14 Tokyo regional
 * multiplier. One unit pair (1 RCU + 1 WCU) held for a 30-day month is therefore:
 *   (0.0001485 + 0.000742) * 720h ≈ $0.64 / month
 * which matches the estimate stated in Issue #2444 and is consistent with the
 * $7.06 / ~37-unit-pair observation recorded in #2435. This is a rough estimate, not a
 * bill — real cost varies by region and any Free Tier / credit offset.
 */
export const RCU_USD_PER_HOUR = 0.0001485;
export const WCU_USD_PER_HOUR = 0.000742;
export const HOURS_PER_MONTH = 720;
export const USD_PER_UNIT_PAIR_MONTH = (RCU_USD_PER_HOUR + WCU_USD_PER_HOUR) * HOURS_PER_MONTH;

export interface RetainedTable {
  readonly name: string;
  /** Base-table + summed GSI read capacity units. */
  readonly readCapacityUnits: number;
  /** Base-table + summed GSI write capacity units. */
  readonly writeCapacityUnits: number;
  readonly gsiCount: number;
  /** Provisioned capacity groups: 1 (base) + one per GSI. */
  readonly unitGroups: number;
}

/** True when `name` belongs to a TenkaCloud stack (case-insensitive prefix match). */
export function isTenkaCloudTable(name: string): boolean {
  return name.toLowerCase().startsWith(TENKACLOUD_TABLE_PREFIX);
}

/** Estimated standing monthly USD for the given provisioned capacity totals. */
export function estimateMonthlyUsd(totalReadUnits: number, totalWriteUnits: number): number {
  return (totalReadUnits * RCU_USD_PER_HOUR + totalWriteUnits * WCU_USD_PER_HOUR) * HOURS_PER_MONTH;
}

interface DescribeTableThroughput {
  readonly ReadCapacityUnits?: number;
  readonly WriteCapacityUnits?: number;
}

interface DescribeTablePayload {
  readonly Table?: {
    readonly ProvisionedThroughput?: DescribeTableThroughput;
    readonly GlobalSecondaryIndexes?: readonly {
      readonly ProvisionedThroughput?: DescribeTableThroughput;
    }[];
  };
}

/**
 * Fold a `describe-table` payload into the base-table + GSI capacity totals. On-demand
 * tables report 0/0 provisioned units (no standing cost) — the platform forbids
 * on-demand, but 0/0 is the safe, correct contribution if one is ever encountered.
 */
export function summarizeTable(name: string, payload: DescribeTablePayload): RetainedTable {
  const table = payload.Table ?? {};
  const base = table.ProvisionedThroughput ?? {};
  const gsis = table.GlobalSecondaryIndexes ?? [];
  let readCapacityUnits = base.ReadCapacityUnits ?? 0;
  let writeCapacityUnits = base.WriteCapacityUnits ?? 0;
  for (const gsi of gsis) {
    readCapacityUnits += gsi.ProvisionedThroughput?.ReadCapacityUnits ?? 0;
    writeCapacityUnits += gsi.ProvisionedThroughput?.WriteCapacityUnits ?? 0;
  }
  return {
    name,
    readCapacityUnits,
    writeCapacityUnits,
    gsiCount: gsis.length,
    unitGroups: 1 + gsis.length,
  };
}

/**
 * List every TenkaCloud-owned DynamoDB table name. Returns `undefined` (not `[]`) when
 * the `list-tables` call fails so the caller can distinguish "no leftovers" from "could
 * not check" (expired creds / denied permission) and degrade gracefully.
 */
export async function listTenkaCloudTables(aws: AwsRunner): Promise<string[] | undefined> {
  const names: string[] = [];
  let startTable: string | undefined;
  do {
    const args = ["dynamodb", "list-tables", "--output", "json"];
    if (startTable) args.push("--exclusive-start-table-name", startTable);
    const result = await aws(args);
    if (result.code !== 0) return undefined;
    let parsed: { TableNames?: string[]; LastEvaluatedTableName?: string };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    for (const name of parsed.TableNames ?? []) {
      if (isTenkaCloudTable(name)) names.push(name);
    }
    startTable = parsed.LastEvaluatedTableName;
  } while (startTable);
  return names;
}

/**
 * Describe one table's provisioned capacity. Returns `undefined` when the table cannot be
 * described (e.g. a race where it was deleted between list and describe) so the caller
 * skips it rather than aborting the whole warning.
 */
export async function describeRetainedTable(
  aws: AwsRunner,
  name: string,
): Promise<RetainedTable | undefined> {
  const result = await aws([
    "dynamodb",
    "describe-table",
    "--table-name",
    name,
    "--output",
    "json",
  ]);
  if (result.code !== 0) return undefined;
  try {
    return summarizeTable(name, JSON.parse(result.stdout) as DescribeTablePayload);
  } catch {
    return undefined;
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Detect + report RETAIN leftover tables. Silent when none remain; a one-line notice when
 * the check itself cannot run; a loud multi-line warning (with cost + delete commands)
 * when tables are found. Always resolves — never throws, never signals a non-zero exit.
 */
export async function warnRetainedTables(io: RetainWarningIo): Promise<void> {
  const names = await listTenkaCloudTables(io.aws);
  if (names === undefined) {
    // Graceful degradation: an expired credential or a denied dynamodb:ListTables must
    // not fail the destroy — surface a single line and move on (Issue #2444 AC).
    io.stderr(
      "[retain-warning] DynamoDB テーブルの確認をスキップしました " +
        "(AWS 認証情報が無効/期限切れ、または dynamodb:ListTables 権限が不足)。\n",
    );
    return;
  }
  if (names.length === 0) return; // No leftovers → stay silent (Issue #2444 AC).

  const tables: RetainedTable[] = [];
  for (const name of names.sort()) {
    const summary = await describeRetainedTable(io.aws, name);
    if (summary) tables.push(summary);
  }
  if (tables.length === 0) return; // Everything vanished between list and describe.

  const totalRead = tables.reduce((sum, t) => sum + t.readCapacityUnits, 0);
  const totalWrite = tables.reduce((sum, t) => sum + t.writeCapacityUnits, 0);
  const totalUnitGroups = tables.reduce((sum, t) => sum + t.unitGroups, 0);
  const monthlyUsd = estimateMonthlyUsd(totalRead, totalWrite);

  const lines: string[] = [
    "",
    "================================================================",
    `[retain-warning] RETAIN のため残存している DynamoDB テーブルが ${tables.length} 件あります`,
    "[retain-warning] RemovalPolicy.RETAIN は履歴保全のため意図的です。削除は運用者の明示的な選択です。",
    "================================================================",
  ];
  for (const t of tables) {
    lines.push(
      `  ${t.name}  (RCU=${t.readCapacityUnits} WCU=${t.writeCapacityUnits} ` +
        `GSI=${t.gsiCount} → ${t.unitGroups} unit組)`,
    );
  }
  lines.push(
    "",
    `[retain-warning] 合計 ${totalUnitGroups} unit組 ` +
      `(RCU=${totalRead} + WCU=${totalWrite}) → 概算 約 ${formatUsd(monthlyUsd)}/月 の課金が続きます`,
    "[retain-warning] (見積り: ap-northeast-1 provisioned list price, " +
      `1 unit組 ≒ ${formatUsd(USD_PER_UNIT_PAIR_MONTH)}/月, ${HOURS_PER_MONTH}h/月。` +
      "実額は region / Free Tier / クレジットで変動します)",
    "[retain-warning] 削除する場合はテーブルごとに以下を実行してください:",
  );
  for (const t of tables) {
    lines.push(`  aws dynamodb delete-table --table-name ${t.name}`);
  }
  lines.push("================================================================", "");
  io.stdout(lines.join("\n"));
}

/** Real `aws` CLI runner (captures stdout/stderr; resolves 127 if the binary is absent). */
export function defaultAwsRunner(): AwsRunner {
  return (args) =>
    new Promise<AwsRunResult>((resolveFn) => {
      const proc = spawn("aws", [...args]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => resolveFn({ code: code ?? 0, stdout, stderr }));
      proc.on("error", () => resolveFn({ code: 127, stdout, stderr }));
    });
}

// CLI entry: `bun run scripts/retain-table-warning.ts` (invoked from cleanup.sh). Always
// exits 0 so it never breaks `set -eo pipefail` / the destroy exit code.
if (import.meta.main) {
  await warnRetainedTables({
    aws: defaultAwsRunner(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exit(0);
}
