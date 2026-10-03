import type { SakuraCredential } from "./runtime/sakura-apprun-adapter.js";
import { createSecureJsonStore, type SecureJsonStoreDeps } from "./secure-json-store.js";

/**
 * [Issue #1412] per-team Sakura API-key store (SSM SecureString)。
 *
 * Sakura は OIDC / STS federation を持たないため Trust Bridge に乗らず、
 * **静的 API key (Access Token + Secret)** を SSM SecureString に保管する。 これは AWS ExternalId 保管
 * ([[external-id-store.ts]]) と同型の **stored-scoped-credential** 経路で、 long-lived ゆえ AWS の 15 分
 * AssumeRole より isolation が弱い → 鍵は AppRun 最小操作に scope + per-team Sakura account 前提 + rotation
 * 対応で補償する (security note)。
 *
 * path 規約: `/{env}/tenants/{tenantId}/teams/{teamSlug}/sakura-api-key`
 *   - **1 team 1 鍵** (ExternalId は 1 tenant 1 値だが、 Sakura は per-team account で鍵を分けるため team 粒度)。
 *   - 値は `{accessToken, accessTokenSecret}` の JSON。 plaintext で返さず、 deploy worker が都度 decrypt 取得。
 *
 * SSM SecureString の get/put/delete 機構は [[secure-json-store.ts]] (汎用) に集約 (= Azure secret store と共有、 DRY)。
 * 本 module は Sakura 固有の path / parse / 名前付き API だけを持つ。 `secrets-manager-forbidden` 準拠。
 */

export type SakuraCredentialStoreDeps = SecureJsonStoreDeps;

export function buildSakuraCredentialParameterName(
  env: string,
  tenantId: string,
  teamSlug: string,
): string {
  // env / tenantId / teamSlug は POSIX 風 path segment に直接埋める (= 許容 charclass の sanitize は caller 責任)。
  // 実運用では env={development,staging,production}, tenantId=ULID, teamSlug は slugify 済なので問題なし。
  return `/${env}/tenants/${tenantId}/teams/${teamSlug}/sakura-api-key`;
}

export function buildSakuraCredentialParameterArnPattern(
  region: string,
  account: string,
  env: string,
): string {
  // IAM policy 用。 tenantId / teamSlug を `*` でワイルドカード化する (= deploy 時点で具体値を知らない)。
  return `arn:aws:ssm:${region}:${account}:parameter/${env}/tenants/*/teams/*/sakura-api-key`;
}

/** SSM から読んだ JSON 文字列を SakuraCredential に narrow する (= 自前保管形式の fail-safe parse)。 */
function parseSakuraCredential(raw: string | undefined): SakuraCredential | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { accessToken, accessTokenSecret } = parsed as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof accessTokenSecret !== "string") return undefined;
  if (accessToken.length === 0 || accessTokenSecret.length === 0) return undefined;
  return { accessToken, accessTokenSecret };
}

const store = createSecureJsonStore<SakuraCredential>({
  buildName: buildSakuraCredentialParameterName,
  parse: parseSakuraCredential,
  serialize: (credential) =>
    JSON.stringify({
      accessToken: credential.accessToken,
      accessTokenSecret: credential.accessTokenSecret,
    }),
});

/**
 * team の Sakura API key を取得。 未登録 / 復号不能な形式なら `undefined`
 * (= 上位で 404 / RuntimeNotSupported に変換する余地を残す = fail-closed)。
 */
export function getSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<SakuraCredential | undefined> {
  return store.get(deps, tenantId, teamSlug);
}

/**
 * team の Sakura API key を登録 / 上書き (register + rotation 兼用、 rotation 対応)。
 * `Overwrite: true` なので 2 回目以降は鍵を差し替える (= rotation = 再 register)。
 */
export function putSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
  credential: SakuraCredential,
): Promise<void> {
  return store.put(deps, tenantId, teamSlug, credential);
}

/**
 * team の Sakura API key を削除 (= revoke / team teardown)。 存在しない場合は no-op (= idempotent)。
 */
export function deleteSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<void> {
  return store.delete(deps, tenantId, teamSlug);
}
