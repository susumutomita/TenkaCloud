#!/usr/bin/env bun
/**
 * Issue #2617: first live Turso E2E verification guide and read-only checks.
 *
 * This command deliberately does not deploy, destroy, or create a Turso token. It gives the
 * operator one discoverable route, checks the selected account / region / public config before
 * deployment, and verifies the two deployed CloudFormation stacks without mutating them.
 *
 * Since #3051 the preflight decrypts the stored token once so it can decode the JWT `exp` claim —
 * an expired token makes every Turso Lambda answer 401 and the console answer 500, and that was
 * invisible to a metadata-only check. The value itself is never logged or returned.
 */

import { spawnSync } from "node:child_process";
import { resolveLiteStackNames } from "../../infrastructure/lib/tenkacloud-lite/stack-names";
import {
  describeTursoTokenExpiry,
  formatTursoTokenExpiryDate,
  TURSO_TOKEN_EXPIRY_WARNING_MS,
} from "./turso-token-rotate";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

export interface CheckResult {
  readonly ok: boolean;
  readonly output: string;
}

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

function parseFeatures(raw: string | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Pure configuration validation. No token value is accepted or inspected here. */
export function validateTursoLiveEnvironment(env: NodeJS.ProcessEnv): readonly string[] {
  const errors: string[] = [];
  if (env.CDK_PARAM_CONTROL_DATA_BACKEND !== "turso") {
    errors.push("CDK_PARAM_CONTROL_DATA_BACKEND=turso が必要です (値は `turso` のみ有効です)");
  }

  const databaseUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim() ?? "";
  if (!/^https:\/\/[^/]+/i.test(databaseUrl)) {
    errors.push(
      "CDK_PARAM_TURSO_DATABASE_URL には `turso db show tenkacloud-lite --http-url` の https:// URL を設定してください",
    );
  }

  const parameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ?? "";
  if (!parameterName.startsWith("/")) {
    errors.push("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME は / で始まる絶対パスが必要です");
  }

  if (!env.AWS_REGION?.trim()) errors.push("AWS_REGION が必要です");
  if (!/^\d{12}$/.test(env.AWS_ACCOUNT_ID?.trim() ?? "")) {
    errors.push("AWS_ACCOUNT_ID はデプロイ先の12桁 AWS account ID が必要です");
  }

  const features = parseFeatures(env.CDK_PARAM_FEATURES);
  if (features?.samlSso !== true) {
    errors.push('SAML IdP CRUD のライブ検証には CDK_PARAM_FEATURES={"samlSso":true} が必要です');
  }
  return errors;
}

function commandFailure(label: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return `✗ ${label}: ${detail}`;
}

/**
 * Check local tools, selected AWS identity, and SSM parameter metadata. `describe-parameters`
 * returns metadata only; unlike `get-parameter`, it never requests the encrypted value field.
 */
export function runTursoLivePreflight(
  env: NodeJS.ProcessEnv,
  run: CommandRunner = defaultRunner,
): CheckResult {
  const lines = ["=== Turso live preflight (read-only) ==="];
  const configErrors = validateTursoLiveEnvironment(env);
  if (configErrors.length > 0) {
    lines.push(...configErrors.map((error) => `✗ ${error}`));
    lines.push("→ make turso-live-guide で設定手順を確認してください");
    return { ok: false, output: lines.join("\n") };
  }

  for (const [command, label] of [
    ["aws", "AWS CLI"],
    ["turso", "Turso CLI"],
  ] as const) {
    const result = run(command, ["--version"]);
    if (result.status !== 0) {
      lines.push(commandFailure(`${label} が実行できません`, result));
      return { ok: false, output: lines.join("\n") };
    }
    lines.push(`✓ ${label}`);
  }

  const identity = run("aws", [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
  ]);
  if (identity.status !== 0) {
    lines.push(commandFailure("aws sts get-caller-identity", identity));
    return { ok: false, output: lines.join("\n") };
  }
  const activeAccount = identity.stdout.trim();
  const expectedAccount = env.AWS_ACCOUNT_ID?.trim() ?? "";
  if (activeAccount !== expectedAccount) {
    lines.push(
      `✗ AWS account mismatch: AWS_ACCOUNT_ID=${expectedAccount}, active=${activeAccount}`,
    );
    return { ok: false, output: lines.join("\n") };
  }
  lines.push(`✓ AWS account: ${activeAccount}`);
  lines.push(`✓ AWS region: ${env.AWS_REGION}`);

  const parameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ?? "";
  const parameter = run("aws", [
    "ssm",
    "describe-parameters",
    "--parameter-filters",
    `Key=Name,Option=Equals,Values=${parameterName}`,
    "--region",
    env.AWS_REGION ?? "",
    "--query",
    "Parameters[0].Type",
    "--output",
    "text",
  ]);
  if (parameter.status !== 0) {
    lines.push(commandFailure(`SSM parameter ${parameterName}`, parameter));
    return { ok: false, output: lines.join("\n") };
  }
  const parameterType = parameter.stdout.trim();
  if (parameterType !== "SecureString") {
    lines.push(`✗ SSM parameter type is ${parameterType || "unknown"}; SecureString が必要です`);
    return { ok: false, output: lines.join("\n") };
  }
  lines.push("✓ SSM parameter: SecureString (値は表示しません)");

  const expiry = checkStoredTokenExpiry(parameterName, env, run);
  lines.push(...expiry.lines);
  if (!expiry.ok) return { ok: false, output: lines.join("\n") };

  lines.push("✓ preflight passed — 次は `make deploy` です");
  return { ok: true, output: lines.join("\n") };
}

function environmentLabel(env: NodeJS.ProcessEnv): string {
  return env.ENV?.trim() || env.CDK_PARAM_ENVIRONMENT?.trim() || "development";
}

/**
 * 保存済み token の JWT `exp` だけを見る。 stdout は token そのものなので、失敗時でも
 * stdout を出力に混ぜない (stderr と exit code だけを報告する)。
 */
function checkStoredTokenExpiry(
  parameterName: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
): { readonly ok: boolean; readonly lines: readonly string[] } {
  const result = run("aws", [
    "ssm",
    "get-parameter",
    "--name",
    parameterName,
    "--with-decryption",
    "--region",
    env.AWS_REGION ?? "",
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    return {
      ok: false,
      lines: [`✗ SSM parameter ${parameterName} の有効期限を確認できません: ${detail}`],
    };
  }
  const rotate = `make turso-token-rotate ENV=${environmentLabel(env)}`;
  const expiry = describeTursoTokenExpiry(result.stdout.trim());
  if (expiry.kind === "never") return { ok: true, lines: ["✓ Turso token: 無期限"] };
  if (expiry.kind === "unknown") {
    return {
      ok: true,
      lines: ["⚠ Turso token: 形式を判定できません (JWT ではないため期限は未確認)"],
    };
  }
  const date = formatTursoTokenExpiryDate(expiry.at);
  const remaining = expiry.at.getTime() - Date.now();
  if (remaining <= 0) {
    return { ok: false, lines: [`✗ Turso token は ${date} に期限切れ (${rotate})`] };
  }
  if (remaining <= TURSO_TOKEN_EXPIRY_WARNING_MS) {
    return { ok: true, lines: [`⚠ Turso token は ${date} に期限切れ — 7日以内 (${rotate})`] };
  }
  return { ok: true, lines: [`✓ Turso token: ${date} まで有効`] };
}

function stackStatusIsComplete(status: string): boolean {
  return (
    status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE" || status === "IMPORT_COMPLETE"
  );
}

interface StackVerification {
  readonly ok: boolean;
  readonly tableCount: number | undefined;
  readonly lines: readonly string[];
}

function verifyStack(stackName: string, region: string, run: CommandRunner): StackVerification {
  const lines: string[] = [];
  const statusResult = run("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--region",
    region,
    "--query",
    "Stacks[0].StackStatus",
    "--output",
    "text",
  ]);
  const status = statusResult.stdout.trim();
  const statusOk = statusResult.status === 0 && stackStatusIsComplete(status);
  if (statusOk) {
    lines.push(`✓ ${stackName}: ${status}`);
  } else if (statusResult.status === 0) {
    lines.push(`✗ ${stackName}: status=${status || "unknown"}`);
  } else {
    lines.push(commandFailure(`${stackName} status`, statusResult));
  }

  const countResult = run("aws", [
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    stackName,
    "--region",
    region,
    "--query",
    "length(StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table'])",
    "--output",
    "text",
  ]);
  const tableCount = Number.parseInt(countResult.stdout.trim(), 10);
  const countKnown = countResult.status === 0 && Number.isInteger(tableCount) && tableCount >= 0;
  if (!countKnown) {
    lines.push(commandFailure(`${stackName} DynamoDB resource count`, countResult));
    return { ok: false, tableCount: undefined, lines };
  }
  lines.push(`${tableCount === 0 ? "✓" : "✗"} ${stackName}: DynamoDB tables=${tableCount}`);
  return { ok: statusOk && tableCount === 0, tableCount, lines };
}

/** Read-only post-deploy proof for the exact two Lite stack names. */
export function runCloudFormationVerification(
  environment: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner = defaultRunner,
): CheckResult {
  const region = env.AWS_REGION?.trim() ?? "";
  if (!region) return { ok: false, output: "✗ AWS_REGION が必要です" };

  const stackNames = resolveLiteStackNames(environment);
  const lines = ["=== Deployed CloudFormation verification (read-only) ==="];
  const results = [stackNames.app, stackNames.problemDeploy].map((stackName) =>
    verifyStack(stackName, region, run),
  );
  lines.push(...results.flatMap((result) => result.lines));
  const counts = results.map((result) => result.tableCount);
  const countsKnown = counts.every((count): count is number => count !== undefined);
  const totalTables = countsKnown ? counts.reduce((sum, count) => sum + count, 0) : undefined;
  const ok = results.every((result) => result.ok) && totalTables === 0;

  if (totalTables === undefined) {
    lines.push("✗ DynamoDB tables: count unavailable");
  } else {
    const mark = totalTables === 0 ? "✓" : "✗";
    lines.push(`${mark} DynamoDB tables: ${totalTables}`);
  }
  if (ok) {
    lines.push("✓ CloudFormation acceptance passed");
  } else {
    lines.push(
      "✗ CloudFormation acceptance failed — deploy を続けず設定と stack を確認してください",
    );
  }
  return { ok, output: lines.join("\n") };
}

export function renderTursoLiveGuide(environment: string): string {
  const stackNames = resolveLiteStackNames(environment);
  const envFile = `infrastructure/environments/${environment}/.env`;
  return [
    "Turso 初回ライブ E2E 検証ガイド",
    "",
    "このガイドは fresh な Lite stack 用です。既存 DynamoDB stack の移行には使わず、",
    "docs/running-costs.md の migration 手順を使ってください。",
    "",
    "推奨: 次のコマンドだけで 1〜7 を対話式に進めます。",
    `   make turso-live ENV=${environment}`,
    "   macOS/Linux は公式CLIをチェックサム検証して ~/.turso に導入します (Homebrew不要)。",
    "   CodeBuild/CI は事前導入済みCLIと secret の TURSO_API_TOKEN を使います。",
    "   token は標準入力経由で SSM に保存し、画面・argv・.env には出しません。",
    "   以下は中断時の再開と手動確認用です。",
    "",
    "0. 全体像",
    "   事前確認 → Turso/SSM 設定 → preflight → deploy → CFn 0-table 証明 → 主要フロー → 証跡記録",
    "",
    "1. AWS と Turso にログイン",
    "   aws sts get-caller-identity",
    "   turso auth login",
    "   turso が PATH にない場合: ~/.turso/turso auth login",
    "",
    "2. Turso DB と書き込み可能 token を作る",
    "   turso db create tenkacloud-lite",
    "   turso db show tenkacloud-lite --http-url",
    "   turso db tokens create tenkacloud-lite --expiration never",
    "   期限付き (Nd) で発行した場合は N 日ごとに `make turso-token-rotate ENV=" +
      `${environment}\` が必要です。`,
    "   token は再表示せず、.env / issue / terminal log に貼らないでください。",
    "",
    "3. token を同じ region の SSM SecureString に保存",
    "   read -rs TURSO_TOKEN",
    `   printf '%s' "$TURSO_TOKEN" | aws ssm put-parameter --name /TenkaCloud/${environment}/turso/auth-token --type SecureString --value file:///dev/stdin --region <AWS_REGION>`,
    "   unset TURSO_TOKEN",
    "",
    `4. ${envFile} を設定`,
    "   CDK_PARAM_CONTROL_DATA_BACKEND=turso",
    "   CDK_PARAM_TURSO_DATABASE_URL=https://<database>-<organization>.turso.io",
    `   CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/${environment}/turso/auth-token`,
    '   CDK_PARAM_FEATURES={"samlSso":true}',
    "   AWS_ACCOUNT_ID / AWS_REGION / TENANT_ADMIN_EMAIL も実値を確認してください。",
    "",
    "5. 事前確認 (AWS/SSM は read-only、token 値の要求なし)",
    `   ENV=${environment} tenkacloud turso-live preflight`,
    "",
    "6. 明示的にライブ deploy (AWS リソースを作成)",
    `   ENV=${environment} tenkacloud turso-live deploy`,
    "   完了するまで terminal を閉じず、失敗時は直前の CDK error を保存してください。",
    "",
    "7. deploy された CFn を検証",
    `   ENV=${environment} tenkacloud turso-live verify-cloudformation`,
    `   対象: ${stackNames.app} / ${stackNames.problemDeploy}`,
    "   両 stack が *_COMPLETE かつ DynamoDB tables 合計 0 であることが合格条件です。",
    "",
    "8. Application Admin Console で主要フローを順番に実行",
    "   a. 招待メールでサインインし、Events 一覧を開く (初回 cold start/schema 作成)",
    "   b. Competitor Accounts → アカウントを追加 → 表示された ExternalId と Launch Stack を保存",
    "   c. 競技者 account で bootstrap stack を作成 → Console に戻って Verify",
    "   d. Events → 新規 Event 作成 (1 team + hello-world + hello-world-battle) → 今すぐ Deploy",
    "   e. Deploy が成功するまで待ち、team login key と Participant Portal URL を控える",
    "   f. Participant Portal に login key で入り、問題 README の手順で解答を提出",
    "   g. Battle の endpoint override を登録 → 更新 → 解除し、ProblemEndpoints CRUD を確認",
    "   h. Event の Disruptions で manual disruption を1回発火し、履歴に出ることを確認",
    "   i. Console の scoreboard / deployment で採点結果が反映されることを確認",
    "   j. 監査ログで create_competitor_account 操作が読めることを確認 (AdminAuditLog)",
    "   k. Identity providers → 実在する検証用 IdP metadata で作成 → 一覧 → 編集 → 削除",
    "",
    "9. 証跡を記録",
    "   docs/running-costs.md の Live evidence template に日時・account/region・CFn出力・",
    "   各フローの結果・CloudWatch error・Turso usage を記入し、token/login key は伏せます。",
    "   AWS Cost Explorer は反映が遅れるため、deploy 当日と後日の請求確認を分けて記録します。",
    "",
    "10. 検証終了後の片付け",
    "   問題 stack → competitor bootstrap → make destroy の順で、所有者が内容を確認して削除します。",
    "   make destroy は destructive なので、このガイドは自動実行しません。",
  ].join("\n");
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: bun run scripts/ops/turso-live-guide.ts <guide|preflight|verify-cloudformation>",
      "",
      "  guide                  Step-by-step runbook (default)",
      "  preflight              Read-only local/AWS/SSM configuration checks",
      "  verify-cloudformation  Read-only deployed stack status + DynamoDB count",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const command = process.argv[2] ?? "guide";
  const environment = process.env.ENV ?? process.env.CDK_PARAM_ENVIRONMENT ?? "development";
  if (command === "guide") {
    process.stdout.write(`${renderTursoLiveGuide(environment)}\n`);
    return 0;
  }
  if (command === "preflight") {
    const result = runTursoLivePreflight(process.env);
    process.stdout.write(`${result.output}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "verify-cloudformation") {
    const result = runCloudFormationVerification(environment, process.env);
    process.stdout.write(`${result.output}\n`);
    return result.ok ? 0 : 1;
  }
  printUsage();
  return 1;
}

if (import.meta.main) process.exitCode = main();
