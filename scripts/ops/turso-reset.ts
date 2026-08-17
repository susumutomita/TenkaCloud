import type { ProcessRunner } from "../cli/process";

/**
 * `make turso-reset` (= `tenkacloud turso-live reset`) の本体。
 *
 * 純 Turso backend の control-data を「スキーマとマイグレーション状態を残して全行削除」する
 * ops コマンド。 遊び終わった Lite のイベント / チーム / デプロイ行を一括で片付ける
 * (2026-07-21 のライブ検証で「初期化手段が無い」ことが判明したため追加)。
 *
 * - 対象 table は sqlite_master から実行時に列挙する (= スキーマ追加時のリスト drift を防ぐ)。
 *   `control_data_migrations` は残す (マイグレーションの再実行を防ぐ)。
 * - 認証は SSM SecureString の auth token を AWS CLI で読む (turso-live-guide と同じ経路。
 *   SDK 依存を scripts 側に増やさない)。
 * - deployments に未削除行が残っている場合、競技アカウント側 CloudFormation stack が
 *   孤児化する恐れを警告してから confirm する。
 * - destructive なので対話 confirm 必須。 非対話 (CI) は `--yes` 指定時のみ実行する。
 */

/** マイグレーション状態は残す (= 再実行させない)。 sqlite 内部 table も対象外。 */
const PRESERVED_TABLES = new Set(["control_data_migrations"]);

interface PipelineCell {
  readonly type: string;
  readonly value?: unknown;
}

interface PipelineExecuteResult {
  readonly type: "ok" | "error";
  readonly response?: {
    readonly result?: {
      readonly rows?: readonly (readonly PipelineCell[])[];
      readonly affected_row_count?: number;
    };
  };
  readonly error?: { readonly message?: string };
}

interface PipelineResponse {
  readonly results?: readonly PipelineExecuteResult[];
}

/** turso-live 系 destructive コマンド (reset / rotate-token) が共有する注入点。 */
export interface TursoOpsDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly environment: string;
  readonly processRunner: ProcessRunner;
  /** `POST <databaseUrl>/v2/pipeline` を投げる seam (テストで fake 注入)。 */
  readonly httpPost: (url: string, authToken: string, body: unknown) => Promise<unknown>;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly interactive: boolean;
  readonly assumeYes: boolean;
}

export type TursoResetDeps = TursoOpsDeps;

export interface TursoResetTarget {
  readonly databaseUrl: string;
  readonly parameterName: string;
}

/** 実行前提の検証。 backend が turso でない環境で誤爆しないよう明示ガードする。 */
export function resolveTursoResetTarget(
  env: NodeJS.ProcessEnv,
):
  | { readonly ok: true; readonly target: TursoResetTarget }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const backend = env.CDK_PARAM_CONTROL_DATA_BACKEND?.trim().toLowerCase() ?? "";
  if (backend !== "turso") {
    errors.push(
      `CDK_PARAM_CONTROL_DATA_BACKEND が turso ではありません (現在: "${backend || "未設定"}")。` +
        " turso backend の環境でのみ実行できます。",
    );
  }
  const databaseUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl.startsWith("https://")) {
    errors.push("CDK_PARAM_TURSO_DATABASE_URL に https:// の Turso URL を設定してください。");
  }
  const parameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ?? "";
  if (!parameterName.startsWith("/")) {
    errors.push("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME は / で始まる絶対パスが必要です。");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, target: { databaseUrl, parameterName } };
}

function fetchAuthToken(deps: TursoResetDeps, parameterName: string): string | undefined {
  const result = deps.processRunner.run("aws", [
    "ssm",
    "get-parameter",
    "--name",
    parameterName,
    "--with-decryption",
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]);
  if (result.status !== 0) {
    deps.log(`SSM から auth token を取得できませんでした: ${result.stderr.trim()}`);
    return undefined;
  }
  const token = result.stdout.trim();
  return token.length > 0 ? token : undefined;
}

function cellText(cell: PipelineCell | undefined): string | undefined {
  return typeof cell?.value === "string" ? cell.value : undefined;
}

async function executePipeline(
  deps: TursoResetDeps,
  target: TursoResetTarget,
  authToken: string,
  statements: readonly string[],
): Promise<readonly PipelineExecuteResult[]> {
  const body = {
    requests: [...statements.map((sql) => ({ type: "execute", stmt: { sql } })), { type: "close" }],
  };
  const raw = (await deps.httpPost(
    `${target.databaseUrl}/v2/pipeline`,
    authToken,
    body,
  )) as PipelineResponse;
  const results = raw.results ?? [];
  for (const [index, result] of results.entries()) {
    if (result.type === "error") {
      throw new Error(
        `Turso pipeline step ${index + 1} failed: ${result.error?.message ?? "unknown error"}`,
      );
    }
  }
  // 末尾は close の ack なので除いて返す。
  return results.slice(0, statements.length);
}

/** 全行削除の対象 table を実 DB から列挙する (= ハードコードのリスト drift を防ぐ)。 */
const LIST_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

const COUNT_DEPLOYMENTS_SQL = "SELECT COUNT(*) FROM deployments";

async function listResetTables(
  deps: TursoResetDeps,
  target: TursoResetTarget,
  authToken: string,
): Promise<readonly string[]> {
  const [tableListResult] = await executePipeline(deps, target, authToken, [LIST_TABLES_SQL]);
  return (tableListResult?.response?.result?.rows ?? [])
    .map((row) => cellText(row[0]))
    .filter((name): name is string => typeof name === "string" && !PRESERVED_TABLES.has(name));
}

/** 競技アカウント側 CloudFormation stack の孤児化リスクを削除前に知らせる。 */
async function warnAboutRemainingDeployments(
  deps: TursoResetDeps,
  target: TursoResetTarget,
  authToken: string,
): Promise<void> {
  const [countResult] = await executePipeline(deps, target, authToken, [COUNT_DEPLOYMENTS_SQL]);
  const countCell = countResult?.response?.result?.rows?.[0]?.[0];
  const remaining = Number(countCell?.value ?? 0);
  if (Number.isFinite(remaining) && remaining > 0) {
    deps.log(
      `⚠ deployments に ${remaining} 行残っています。競技アカウント側の CloudFormation stack が` +
        " 生きている場合、先に管理コンソールから削除しないと孤児化します。",
    );
  }
}

/** destructive ガード: 対話 confirm 必須、非対話は --yes のみ許可。 */
async function confirmReset(deps: TursoResetDeps): Promise<boolean> {
  if (deps.assumeYes) return true;
  if (!deps.interactive) {
    deps.log("非対話環境では --yes を付けたときだけ実行します。中止しました。");
    return false;
  }
  const confirmed = await deps.confirm(
    "上記すべての table の全行を削除します。取り消せません。実行しますか?",
  );
  if (!confirmed) deps.log("中止しました。");
  return confirmed;
}

/** ガード結果を log に流し、通ったときだけ target を返す (reset / rotate-token 共通)。 */
export function resolveTursoTargetOrLog(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): TursoResetTarget | undefined {
  const resolved = resolveTursoResetTarget(env);
  if (resolved.ok) return resolved.target;
  for (const error of resolved.errors) log(`✗ ${error}`);
  return undefined;
}

export async function runTursoReset(deps: TursoResetDeps): Promise<number> {
  const target = resolveTursoTargetOrLog(deps.env, deps.log);
  if (!target) return 1;

  const authToken = fetchAuthToken(deps, target.parameterName);
  if (!authToken) return 1;

  const tables = await listResetTables(deps, target, authToken);
  if (tables.length === 0) {
    deps.log("削除対象の table がありません (スキーマ未初期化の可能性)。何もせず終了します。");
    return 0;
  }
  if (tables.includes("deployments")) {
    await warnAboutRemainingDeployments(deps, target, authToken);
  }

  deps.log(`環境: ${deps.environment}`);
  deps.log(`DB:   ${target.databaseUrl}`);
  deps.log(`対象: ${tables.length} tables (${tables.join(", ")})`);
  deps.log(`維持: ${[...PRESERVED_TABLES].join(", ")} (スキーマと共に残ります)`);

  if (!(await confirmReset(deps))) return 1;

  const deleteResults = await executePipeline(
    deps,
    target,
    authToken,
    tables.map((table) => `DELETE FROM "${table}"`),
  );
  for (const [index, result] of deleteResults.entries()) {
    const affected = result.response?.result?.affected_row_count ?? 0;
    deps.log(`  ${tables[index]}: ${affected} 行削除`);
  }
  deps.log("✓ Turso control-data を初期化しました (スキーマは維持)。");
  return 0;
}

/** production 用の fetch 実装。 scripts 層なので fetch 直呼びは harness 対象外。 */
export async function tursoPipelinePost(
  url: string,
  authToken: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Turso pipeline HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
