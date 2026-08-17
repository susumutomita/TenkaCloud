import type { ProcessRunner } from "../cli/process";
import { resolveTursoResetTarget, type TursoResetTarget } from "./turso-reset";

/**
 * `make turso-token-rotate` (= `tenkacloud turso-live rotate-token`) の本体。
 *
 * Turso DB token が期限切れになると、Turso を使う全 Lambda が `HTTP status 401` を返し
 * Console が `API 500` になる (2026-08-17 の Lite 障害)。 復旧手段が「CLI で token を作って
 * 手で SSM に put」しかなく、token を端末に表示させる事故が起きやすかったので、
 * 「表示せずに再発行して SSM SecureString を上書きし、実際に使えることまで確かめる」
 * 経路を 1 本用意する。
 *
 * - 前提ガードは `resolveTursoResetTarget` を再利用する (backend=turso / https URL / 絶対 SSM path)。
 * - token は **メモリ内だけ** で扱う。 log / throw message / argv のどこにも出さない
 *   (SSM へは stdin 経由で渡す)。 CLI が失敗したときの stdout には途中まで生成された
 *   secret が乗り得るので、失敗メッセージは redact する。
 * - SSM を更新したあと `select 1` を実際に投げて検証する。 失敗を成功に見せない。
 */

/** JWT は header.payload.signature の 3 パート。 */
const JWT_PART_COUNT = 3;
/** 1 行まるごと base64url の 3 パート (空白なし) = token 行とみなす。 */
const JWT_LINE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86_400;
/** これ以内に切れる token は「もう使い続けられない」とみなして rotate を促す。 */
const EXPIRY_WARNING_DAYS = 7;
export const TURSO_TOKEN_EXPIRY_WARNING_MS =
  EXPIRY_WARNING_DAYS * SECONDS_PER_DAY * MILLISECONDS_PER_SECOND;

/** Turso CLI の `--expiration` 既定値 (CLI 自体の default と同じ)。 */
export const DEFAULT_TURSO_TOKEN_EXPIRATION = "never";

export type TursoTokenExpiry =
  | { readonly kind: "never" }
  | { readonly kind: "expires"; readonly at: Date }
  | { readonly kind: "unknown" };

function decodeJwtPayload(part: string | undefined): Record<string, unknown> | undefined {
  if (!part) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * token の JWT payload から有効期限だけを読む。 値そのものは返さないので、呼び出し側が
 * 誤って token を表示する余地を作らない。 `exp` が無い = Turso の無期限 token。
 */
export function describeTursoTokenExpiry(token: string): TursoTokenExpiry {
  const parts = token.trim().split(".");
  if (parts.length !== JWT_PART_COUNT) return { kind: "unknown" };
  const payload = decodeJwtPayload(parts[1]);
  if (!payload) return { kind: "unknown" };
  // exp が無い = Turso の無期限 token。 exp はあるが数値でない = 判定不能 (never と断定しない)。
  if (!Object.hasOwn(payload, "exp")) return { kind: "never" };
  const expiresAt = payload.exp;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { kind: "unknown" };
  return { kind: "expires", at: new Date(expiresAt * MILLISECONDS_PER_SECOND) };
}

const ISO_DATE_LENGTH = 10;

/** 表示用の YYYY-MM-DD (UTC 固定で、実行ホストの時刻設定に依存させない)。 */
export function formatTursoTokenExpiryDate(at: Date): string {
  return at.toISOString().slice(0, ISO_DATE_LENGTH);
}

export interface TursoTokenRotateDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly environment: string;
  readonly processRunner: ProcessRunner;
  /** 解決済みの turso CLI 実行パス (`turso` または `~/.turso/turso`)。 */
  readonly tursoExecutable: string;
  /** `POST <databaseUrl>/v2/pipeline` を投げる seam (テストで fake 注入)。 */
  readonly httpPost: (url: string, authToken: string, body: unknown) => Promise<unknown>;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly interactive: boolean;
  readonly assumeYes: boolean;
  /** 発行前に既存 token を全部失効させる (漏えい時用)。 */
  readonly invalidate: boolean;
  readonly expiration: string;
  /** 省略時は `turso db list` の URL を CDK_PARAM_TURSO_DATABASE_URL と突合する。 */
  readonly database?: string;
}

interface TursoDatabaseRow {
  readonly name: string;
  readonly url: string;
}

const SCHEME_SEPARATOR = "://";

/** scheme と末尾スラッシュを落として host を比較可能にする (libsql:// と https:// を揃える)。 */
function normalizeDatabaseHost(url: string): string {
  const trimmed = url.trim();
  const schemeEnd = trimmed.indexOf(SCHEME_SEPARATOR);
  const withoutScheme =
    schemeEnd < 0 ? trimmed : trimmed.slice(schemeEnd + SCHEME_SEPARATOR.length);
  let end = withoutScheme.length;
  while (end > 0 && withoutScheme[end - 1] === "/") end -= 1;
  return withoutScheme.slice(0, end).toLowerCase();
}

/**
 * `turso db list` の whitespace 整列テーブルを読む。 `--json` は CLI v1.0.31 に存在しない。
 * ヘッダ行の文言には依存せず「最後の列が URL に見える行」だけを採用する。
 */
export function parseTursoDatabaseList(stdout: string): readonly TursoDatabaseRow[] {
  const rows: TursoDatabaseRow[] = [];
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/).filter(Boolean);
    const url = columns.at(-1) ?? "";
    const name = columns[0] ?? "";
    if (columns.length < 2 || !name || !/^(?:libsql|https?):\/\//i.test(url)) continue;
    rows.push({ name, url });
  }
  return rows;
}

function resolveDatabaseName(
  deps: TursoTokenRotateDeps,
  target: TursoResetTarget,
): string | undefined {
  const explicit = deps.database?.trim();
  if (explicit) return explicit;
  const listed = deps.processRunner.run(deps.tursoExecutable, ["db", "list"]);
  if (listed.status !== 0) {
    const detail = listed.stderr.trim() || listed.stdout.trim() || `exit ${listed.status}`;
    deps.log(`✗ turso db list に失敗しました: ${detail}`);
    deps.log("→ `turso auth login` の状態を確認するか、--database <name> で明示してください。");
    return undefined;
  }
  const wanted = normalizeDatabaseHost(target.databaseUrl);
  const matches = parseTursoDatabaseList(listed.stdout).filter(
    (row) => normalizeDatabaseHost(row.url) === wanted,
  );
  if (matches.length !== 1) {
    deps.log(
      `✗ CDK_PARAM_TURSO_DATABASE_URL (${target.databaseUrl}) に一致する Turso database を` +
        ` 一意に特定できませんでした (該当 ${matches.length} 件)。`,
    );
    deps.log("→ --database <name> で対象 database を明示してください (推測はしません)。");
    return undefined;
  }
  return matches[0]?.name;
}

/** destructive ガード: 対話 confirm 必須、非対話は --yes のみ許可。 */
async function confirmRotate(deps: TursoTokenRotateDeps): Promise<boolean> {
  if (deps.assumeYes) return true;
  if (!deps.interactive) {
    deps.log("非対話環境では --yes を付けたときだけ実行します。中止しました。");
    return false;
  }
  const question = deps.invalidate
    ? "この database の既存 token を **すべて失効** させたうえで新しい token を発行し、SSM を上書きします。他所で同じ token を使っていれば止まります。実行しますか?"
    : "新しい token を発行して SSM SecureString を上書きします。実行しますか?";
  const confirmed = await deps.confirm(question);
  if (!confirmed) deps.log("中止しました。");
  return confirmed;
}

function invalidateExistingTokens(deps: TursoTokenRotateDeps, databaseName: string): void {
  const result = deps.processRunner.run(deps.tursoExecutable, [
    "db",
    "tokens",
    "invalidate",
    databaseName,
    "--yes",
  ]);
  // 失敗時の stdout/stderr には token 断片が乗り得るので詳細は載せない。
  if (result.status !== 0) {
    throw new Error("turso db tokens invalidate failed (command output redacted)");
  }
  deps.log("✓ 既存 token をすべて失効させました。");
}

function issueToken(deps: TursoTokenRotateDeps, databaseName: string): string {
  const result = deps.processRunner.run(deps.tursoExecutable, [
    "db",
    "tokens",
    "create",
    databaseName,
    "--expiration",
    deps.expiration,
  ]);
  if (result.status !== 0) {
    throw new Error("turso db tokens create failed (command output redacted)");
  }
  // Turso CLI は自動アップデート通知などを stdout に混ぜることがある (2026-08-17 に実測)。
  // 「JWT 形状の行がちょうど 1 行」だけを token として採用し、それ以外は fail loud する。
  const candidates = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => JWT_LINE_RE.test(line));
  const token = candidates[0];
  if (candidates.length !== 1 || !token) {
    throw new Error("Turso returned an invalid database token (value redacted)");
  }
  return token;
}

function parseParameterVersion(stdout: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const version = (parsed as { Version?: unknown } | null)?.Version;
    return typeof version === "number" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** token は argv ではなく stdin で渡す (ps / shell history に残さない)。 */
function storeToken(
  deps: TursoTokenRotateDeps,
  target: TursoResetTarget,
  databaseName: string,
  token: string,
): number | undefined {
  const region = deps.env.AWS_REGION?.trim();
  const result = deps.processRunner.run(
    "aws",
    [
      "ssm",
      "put-parameter",
      "--name",
      target.parameterName,
      "--type",
      "SecureString",
      "--overwrite",
      "--value",
      "file:///dev/stdin",
      "--description",
      `TenkaCloud ${databaseName} database token`,
      ...(region ? ["--region", region] : []),
      "--output",
      "json",
      "--no-cli-pager",
    ],
    { input: token },
  );
  if (result.status !== 0) {
    throw new Error("aws ssm put-parameter failed (command output redacted)");
  }
  return parseParameterVersion(result.stdout);
}

/** 万一 Turso 側の応答が token を echo しても表示されないようにする。 */
function redactToken(message: string, token: string): string {
  return message.split(token).join("***");
}

interface PipelineResult {
  readonly type?: string;
  readonly error?: { readonly message?: string };
}

const SELECT_ONE_BODY = {
  requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }],
} as const;

async function verifyToken(
  deps: TursoTokenRotateDeps,
  target: TursoResetTarget,
  token: string,
): Promise<boolean> {
  const fail = (detail: string): boolean => {
    deps.log(
      `✗ 検証失敗 (${redactToken(detail, token)})。SSM は更新済みですが token が使えません。`,
    );
    deps.log("→ Turso 側の database / 権限を確認し、必要なら --database を指定して再実行します。");
    return false;
  };
  try {
    const raw = (await deps.httpPost(
      `${target.databaseUrl}/v2/pipeline`,
      token,
      SELECT_ONE_BODY,
    )) as { readonly results?: readonly PipelineResult[] };
    const failed = (raw.results ?? []).find((result) => result.type === "error");
    return failed ? fail(failed.error?.message ?? "unknown pipeline error") : true;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function logExpiry(deps: TursoTokenRotateDeps, token: string): void {
  const expiry = describeTursoTokenExpiry(token);
  if (expiry.kind === "never") {
    deps.log("✓ 有効期限: 無期限 (定期的な再発行は不要です)。");
    return;
  }
  if (expiry.kind === "expires") {
    deps.log(`✓ 有効期限: ${formatTursoTokenExpiryDate(expiry.at)} まで。`);
    deps.log(
      `→ 期限前に \`make turso-token-rotate ENV=${deps.environment}\` を再実行してください。`,
    );
    return;
  }
  deps.log("⚠ 有効期限を判定できませんでした (JWT ではない形式の token です)。");
}

function logPlan(deps: TursoTokenRotateDeps, target: TursoResetTarget, databaseName: string): void {
  deps.log(`環境:            ${deps.environment}`);
  deps.log(`Turso database:  ${databaseName}`);
  deps.log(`database URL:    ${target.databaseUrl}`);
  deps.log(`SSM parameter:   ${target.parameterName}`);
  deps.log(`expiration:      ${deps.expiration}`);
  deps.log(`既存 token の失効: ${deps.invalidate ? "する (--invalidate)" : "しない"}`);
}

export async function runTursoTokenRotate(deps: TursoTokenRotateDeps): Promise<number> {
  const resolved = resolveTursoResetTarget(deps.env);
  if (!resolved.ok) {
    for (const error of resolved.errors) deps.log(`✗ ${error}`);
    return 1;
  }
  const { target } = resolved;

  const databaseName = resolveDatabaseName(deps, target);
  if (!databaseName) return 1;

  logPlan(deps, target, databaseName);
  if (!(await confirmRotate(deps))) return 1;

  if (deps.invalidate) invalidateExistingTokens(deps, databaseName);
  const token = issueToken(deps, databaseName);
  const version = storeToken(deps, target, databaseName, token);
  deps.log(
    version === undefined
      ? "✓ SSM SecureString に保存しました (token は表示していません)。"
      : `✓ SSM に保存しました (Version ${version})。token は表示していません。`,
  );

  if (!(await verifyToken(deps, target, token))) return 1;
  deps.log("✓ 新しい token で select 1 が成功しました。");
  logExpiry(deps, token);
  deps.log(
    "Lambda の再デプロイは不要です (初期化に失敗した instance は cache を捨てて SSM を読み直します)。",
  );
  deps.log(
    "旧 token で既に成功していた warm instance は recycle まで旧 token を使うため、" +
      "--invalidate した場合は短時間 401 が続き得ます。",
  );
  return 0;
}
