#!/usr/bin/env bun
/**
 * Issue #952 (epic): TenkaCloud platform の operational state を 1 コマンドで観察する CLI。
 *
 * AI 無人運用の最初の一歩。 操作者 (= 大会主催) や AI agent が「いま platform は健全か」 を
 * 知るための **read-only** subcommand 群。 mutate 操作 (deploy / destroy / rotate 等) は
 * 既存の make target に閉じ込め、 本 CLI は観察に専念する (= 安全な automation 経路を作る)。
 *
 * Usage:
 *   bun run scripts/tenkacloud-ops.ts health [--region <r>]
 *   bun run scripts/tenkacloud-ops.ts help
 *
 * 設計判断:
 *   - aws CLI を spawn (= AWS SDK の依存追加を避ける、 install.sh が aws CLI を要求済)
 *   - test 容易性のため `runHealth` を export し spawnCapture を injectable に
 *   - mutate 操作は持たない (= AI agent が誤って destroy する事故を避ける)
 *
 * 想定 stack 名 prefix:
 *   - SaaS mode: serverless-saas-ref-arch-* / tenkacloud-control-plane / tenkacloud-* / tc-*
 *   - Lite mode: tenkacloud-lite / tenkacloud-lite-problem-deploy
 *   - Problem deploy: tc-{problemSlug}-{teamSlug}
 */

import { type SpawnResult, spawnCapture } from "./lib/spawn-utils";

const HELP_TEXT = `tenkacloud ops — TenkaCloud platform observation CLI (read-only)

Usage:
  bun run scripts/tenkacloud-ops.ts health [--region <r>]
  bun run scripts/tenkacloud-ops.ts metrics --table <DeploymentsTableName> [--region <r>]
  bun run scripts/tenkacloud-ops.ts help

Subcommands:
  health   全 TenkaCloud stack の CFn StackStatus を 1 行ずつ表示
  metrics  Deployments table を scan し rehearsal メトリクス (status 内訳 / deploy 成功率 /
           deploy 所要時間 / 初回 deploy wall-clock) を自動集計 (Issue #2018)
  help     このヘルプ

Examples:
  bun run scripts/tenkacloud-ops.ts health
  bun run scripts/tenkacloud-ops.ts health --region us-east-1
  bun run scripts/tenkacloud-ops.ts metrics --table tenkacloud-lite-problem-deploy-Deployments

See also:
  make lite-status   (= Lite mode 専用の status、 scripts/tenkacloud-lite.ts)
  docs/operations/lite-event-rehearsal.md  (= リハーサル runbook + 記録テンプレート)
`;

/** Re-exported for backwards-compatible imports; the canonical type is `SpawnResult`. */
export type SpawnCaptureResult = SpawnResult;

export type SpawnCapture = (cmd: string, args: readonly string[]) => Promise<SpawnResult>;

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly spawnCapture: SpawnCapture;
}

const TENKACLOUD_STACK_PREFIXES = ["tenkacloud-", "serverless-saas-ref-arch-", "tc-"] as const;

const CFN_STACK_STATUS_FILTER = [
  "CREATE_IN_PROGRESS",
  "CREATE_FAILED",
  "CREATE_COMPLETE",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "DELETE_IN_PROGRESS",
  "DELETE_FAILED",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_FAILED",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE",
  "REVIEW_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_IN_PROGRESS",
  "IMPORT_ROLLBACK_FAILED",
  "IMPORT_ROLLBACK_COMPLETE",
] as const;

export interface CfnStackSummary {
  readonly StackName: string;
  readonly StackStatus: string;
  readonly LastUpdatedTime?: string;
  readonly CreationTime?: string;
}

export interface StackHealthBuckets {
  readonly healthy: readonly CfnStackSummary[];
  readonly inProgress: readonly CfnStackSummary[];
  readonly failed: readonly CfnStackSummary[];
}

export function buildListStacksArgs(region?: string): readonly string[] {
  const args: string[] = [
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    ...CFN_STACK_STATUS_FILTER,
    "--output",
    "json",
  ];
  if (region) args.push("--region", region);
  return args;
}

export function parseStackSummariesJson(
  stdout: string,
): { ok: true; stacks: readonly CfnStackSummary[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(stdout) as { StackSummaries?: CfnStackSummary[] };
    return { ok: true, stacks: parsed.StackSummaries ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function filterTenkaCloudStacks(
  stacks: readonly CfnStackSummary[],
): readonly CfnStackSummary[] {
  return stacks.filter((s) => TENKACLOUD_STACK_PREFIXES.some((p) => s.StackName.startsWith(p)));
}

export function classifyStacks(stacks: readonly CfnStackSummary[]): StackHealthBuckets {
  const healthy: CfnStackSummary[] = [];
  const inProgress: CfnStackSummary[] = [];
  const failed: CfnStackSummary[] = [];
  for (const s of stacks) {
    if (s.StackStatus.includes("FAILED") || s.StackStatus.includes("ROLLBACK")) {
      failed.push(s);
    } else if (s.StackStatus.includes("IN_PROGRESS")) {
      inProgress.push(s);
    } else {
      healthy.push(s);
    }
  }
  return { healthy, inProgress, failed };
}

// exit code: failed 1 件以上で 2、 in_progress のみで 1、 すべて healthy で 0
export function computeHealthExitCode(buckets: StackHealthBuckets): 0 | 1 | 2 {
  if (buckets.failed.length > 0) return 2;
  if (buckets.inProgress.length > 0) return 1;
  return 0;
}

// ---- metrics subcommand (Issue #2018: rehearsal メトリクス自動集計) ----

/**
 * Deployments DDB table の 1 行を rehearsal メトリクス計算に必要な field だけへ射影したもの。
 * `aws dynamodb scan --output json` の low-level attribute 形式 (`{ "S": "..." }`) から取り出す。
 */
export interface DeploymentRecord {
  readonly status: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly problemId?: string;
}

export interface RehearsalMetrics {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly complete: number;
  readonly failed: number;
  /** complete / (complete + failed) の百分率。terminal な結果が無ければ null。 */
  readonly successRatePct: number | null;
  /** COMPLETE 各行の createdAt→updatedAt 所要秒の統計。データ無しなら null。 */
  readonly durationsSec: {
    readonly count: number;
    readonly minSec: number;
    readonly medianSec: number;
    readonly maxSec: number;
  } | null;
  /** batch 全体の wall-clock: min(createdAt) → max(COMPLETE updatedAt) の経過秒。算出不能なら null。 */
  readonly wallClockSpanSec: number | null;
}

export function buildScanDeploymentsArgs(table: string, region?: string): readonly string[] {
  const args: string[] = ["dynamodb", "scan", "--table-name", table, "--output", "json"];
  if (region) args.push("--region", region);
  return args;
}

export function parseDeploymentsScanJson(
  stdout: string,
): { ok: true; records: readonly DeploymentRecord[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(stdout) as { Items?: Array<Record<string, { S?: string }>> };
    const records: DeploymentRecord[] = (parsed.Items ?? []).map((item) => ({
      status: item.status?.S ?? "UNKNOWN",
      createdAt: item.createdAt?.S,
      updatedAt: item.updatedAt?.S,
      problemId: item.problemId?.S,
    }));
    return { ok: true, records };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** COMPLETE 行の createdAt→updatedAt 所要秒 (昇順)。範囲外・パース不能・負値は除外。 */
function completeDurationsSec(records: readonly DeploymentRecord[]): number[] {
  const out: number[] = [];
  for (const r of records) {
    if (r.status !== "COMPLETE" || !r.createdAt || !r.updatedAt) continue;
    const start = Date.parse(r.createdAt);
    const end = Date.parse(r.updatedAt);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
    out.push(Math.round((end - start) / 1000));
  }
  return out.sort((a, b) => a - b);
}

export function computeRehearsalMetrics(records: readonly DeploymentRecord[]): RehearsalMetrics {
  const byStatus: Record<string, number> = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const complete = byStatus.COMPLETE ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const terminal = complete + failed;
  const successRatePct = terminal > 0 ? Math.round((complete / terminal) * 100) : null;

  const durations = completeDurationsSec(records);
  const durationsSec =
    durations.length > 0
      ? {
          count: durations.length,
          minSec: durations[0],
          medianSec: medianOf(durations),
          maxSec: durations[durations.length - 1],
        }
      : null;

  const createdTimes = records
    .map((r) => (r.createdAt ? Date.parse(r.createdAt) : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  const completeUpdated = records
    .filter(
      (r): r is DeploymentRecord & { updatedAt: string } =>
        r.status === "COMPLETE" && !!r.updatedAt,
    )
    .map((r) => Date.parse(r.updatedAt))
    .filter((t) => !Number.isNaN(t));
  let wallClockSpanSec: number | null = null;
  if (createdTimes.length > 0 && completeUpdated.length > 0) {
    const span = Math.max(...completeUpdated) - Math.min(...createdTimes);
    wallClockSpanSec = span >= 0 ? Math.round(span / 1000) : null;
  }

  return {
    total: records.length,
    byStatus,
    complete,
    failed,
    successRatePct,
    durationsSec,
    wallClockSpanSec,
  };
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

export function formatRehearsalMetrics(
  metrics: RehearsalMetrics,
  table: string,
  region: string | undefined,
): string {
  const lines: string[] = [`Rehearsal metrics — table=${table} (region=${region ?? "default"})\n`];
  lines.push(`  deployments (total):     ${metrics.total}`);
  for (const s of Object.keys(metrics.byStatus).sort()) {
    lines.push(`    ${s.padEnd(18)} ${metrics.byStatus[s]}`);
  }
  lines.push(
    `  deploy success rate:     ${
      metrics.successRatePct === null
        ? "n/a (no terminal deploys)"
        : `${metrics.successRatePct}% (${metrics.complete}/${metrics.complete + metrics.failed})`
    }`,
  );
  lines.push(
    metrics.durationsSec
      ? `  per-deploy duration:     min ${fmtDuration(metrics.durationsSec.minSec)} / median ${fmtDuration(metrics.durationsSec.medianSec)} / max ${fmtDuration(metrics.durationsSec.maxSec)} (n=${metrics.durationsSec.count})`
      : "  per-deploy duration:     n/a (no COMPLETE deploys with timestamps)",
  );
  lines.push(
    `  first-deploy wall-clock: ${metrics.wallClockSpanSec === null ? "n/a" : fmtDuration(metrics.wallClockSpanSec)}`,
  );
  lines.push(
    "\n  (manual metrics — see docs/operations/lite-event-rehearsal.md: 失敗復旧時間 / 運営者介入 / 参加者開始 / AWS コスト)\n",
  );
  return lines.join("\n");
}

export async function runMetrics(io: CliIO, table: string, region?: string): Promise<number> {
  const result = await io.spawnCapture("aws", buildScanDeploymentsArgs(table, region));
  if (result.code !== 0) {
    io.stderr(`aws dynamodb scan failed (exit ${result.code}):\n${result.stderr}`);
    return result.code === 0 ? 1 : result.code;
  }
  const parsed = parseDeploymentsScanJson(result.stdout);
  if (!parsed.ok) {
    io.stderr(`failed to parse aws output: ${parsed.error}`);
    return 1;
  }
  io.stdout(formatRehearsalMetrics(computeRehearsalMetrics(parsed.records), table, region));
  return 0;
}

function printHealthSummary(
  io: CliIO,
  ours: readonly CfnStackSummary[],
  buckets: StackHealthBuckets,
  region: string | undefined,
): void {
  const widest = ours.reduce((m, s) => Math.max(m, s.StackName.length), 0);
  const summarize = (label: string, list: readonly CfnStackSummary[]): void => {
    if (list.length === 0) return;
    io.stdout(`\n${label} (${list.length})\n`);
    for (const s of list) {
      io.stdout(`  ${s.StackName.padEnd(widest)}  ${s.StackStatus}\n`);
    }
  };
  io.stdout(`TenkaCloud stacks: ${ours.length} total (region=${region ?? "default"})\n`);
  summarize("FAILED / ROLLBACK", buckets.failed);
  summarize("IN_PROGRESS", buckets.inProgress);
  summarize("HEALTHY", buckets.healthy);
}

/**
 * `aws cloudformation list-stacks` を spawn して TenkaCloud 関連 stack の status を集める。
 *
 * stack filter:
 *   - DELETE_COMPLETE は除外 (= ノイズ)
 *   - 名前 prefix が tenkacloud-* / serverless-saas-ref-arch-* / tc-* のいずれか
 */
export async function runHealth(io: CliIO, region?: string): Promise<number> {
  const result = await io.spawnCapture("aws", buildListStacksArgs(region));
  if (result.code !== 0) {
    io.stderr(`aws cloudformation list-stacks failed (exit ${result.code}):\n${result.stderr}`);
    return result.code === 0 ? 1 : result.code;
  }
  const parsed = parseStackSummariesJson(result.stdout);
  if (!parsed.ok) {
    io.stderr(`failed to parse aws output: ${parsed.error}`);
    return 1;
  }
  const ours = filterTenkaCloudStacks(parsed.stacks);
  if (ours.length === 0) {
    io.stdout("(no TenkaCloud stacks found)\n");
    return 0;
  }
  const buckets = classifyStacks(ours);
  printHealthSummary(io, ours, buckets, region);
  return computeHealthExitCode(buckets);
}

export async function main(argv: readonly string[], ioOverride?: Partial<CliIO>): Promise<number> {
  const io: CliIO = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    spawnCapture,
    ...ioOverride,
  };

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const command = argv[0];
  if (command !== "health" && command !== "metrics") {
    io.stderr(`unknown command: ${command}. Try 'help', 'health', or 'metrics'.\n`);
    return 1;
  }

  let region: string | undefined;
  let table: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--region") {
      region = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--table") {
      table = argv[i + 1];
      i += 1;
    } else {
      io.stderr(`unknown flag: ${argv[i]}\n`);
      return 1;
    }
  }

  if (command === "metrics") {
    if (!table) {
      io.stderr("metrics requires --table <DeploymentsTableName>\n");
      return 1;
    }
    return await runMetrics(io, table, region);
  }

  return await runHealth(io, region);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
