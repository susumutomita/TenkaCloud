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

import { spawn } from "node:child_process";

const HELP_TEXT = `tenkacloud ops — TenkaCloud platform observation CLI (read-only)

Usage:
  bun run scripts/tenkacloud-ops.ts health [--region <r>]
  bun run scripts/tenkacloud-ops.ts help

Subcommands:
  health   全 TenkaCloud stack の CFn StackStatus を 1 行ずつ表示
  help     このヘルプ

Examples:
  bun run scripts/tenkacloud-ops.ts health
  bun run scripts/tenkacloud-ops.ts health --region us-east-1

See also:
  make lite-status   (= Lite mode 専用の status、 scripts/tenkacloud-lite.ts)
`;

export interface SpawnCaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnCapture = (cmd: string, args: readonly string[]) => Promise<SpawnCaptureResult>;

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

function defaultSpawnCapture(): SpawnCapture {
  return (cmd: string, args: readonly string[]) =>
    new Promise<SpawnCaptureResult>((resolveSpawn) => {
      const child = spawn(cmd, args as string[], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("close", (code: number | null) => {
        resolveSpawn({ code: code ?? 0, stdout, stderr });
      });
      child.on("error", (err: Error) => {
        resolveSpawn({ code: 127, stdout: "", stderr: err.message });
      });
    });
}

export async function main(argv: readonly string[], ioOverride?: Partial<CliIO>): Promise<number> {
  const io: CliIO = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    spawnCapture: defaultSpawnCapture(),
    ...ioOverride,
  };

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const command = argv[0];
  if (command !== "health") {
    io.stderr(`unknown command: ${command}. Try 'help' or 'health'.\n`);
    return 1;
  }

  let region: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--region") {
      region = argv[i + 1];
      i += 1;
    } else {
      io.stderr(`unknown flag: ${argv[i]}\n`);
      return 1;
    }
  }

  return await runHealth(io, region);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
