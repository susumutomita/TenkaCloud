import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterType,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import type { SakuraCredential } from "./runtime/sakura-apprun-adapter.js";
import { isParameterNotFound } from "./ssm-parameter.js";

/**
 * [ADR-026 / Issue #1412] per-team Sakura API-key store (SSM SecureString)。
 *
 * ADR-026 D3: Sakura は OIDC / STS federation を持たないため Trust Bridge (ADR-017) に乗らず、
 * **静的 API key (Access Token + Secret)** を SSM SecureString に保管する。 これは AWS ExternalId 保管
 * ([[external-id-store.ts]]) と同型の **stored-scoped-credential** 経路で、 long-lived ゆえ AWS の 15 分
 * AssumeRole より isolation が弱い → 鍵は AppRun 最小操作に scope + per-team Sakura account 前提 + rotation
 * 対応で補償する (ADR-026 D3 security note)。
 *
 * path 規約: `/{env}/tenants/{tenantId}/teams/{teamSlug}/sakura-api-key`
 *   - **1 team 1 鍵** (ExternalId は 1 tenant 1 値だが、 Sakura は per-team account で鍵を分けるため team 粒度)。
 *   - KMS は AWS managed (`alias/aws/ssm`、 コスト 0)。
 *   - tenantId / teamSlug を path 中段に置き、 IAM policy は prefix で絞り込む。
 *   - 値は `{accessToken, accessTokenSecret}` の JSON。 plaintext で返さず、 deploy worker が都度 decrypt 取得。
 *
 * `secrets-manager-forbidden` enforcement と整合: Secrets Manager は使わない (SSM SecureString のみ)。
 */

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

export interface SakuraCredentialStoreDeps {
  readonly ssm: Pick<SSMClient, "send">;
  readonly env: string;
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

/**
 * team の Sakura API key を取得。 未登録 / 復号不能な形式なら `undefined`
 * (= 上位で 404 / RuntimeNotSupported に変換する余地を残す = fail-closed)。
 */
export async function getSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<SakuraCredential | undefined> {
  const name = buildSakuraCredentialParameterName(deps.env, tenantId, teamSlug);
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return parseSakuraCredential(out.Parameter?.Value);
  } catch (err) {
    if (isParameterNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * team の Sakura API key を登録 / 上書き (= register + rotation 兼用、 ADR-026 D3 rotation 対応)。
 *
 * `Overwrite: true` なので 2 回目以降は鍵を差し替える (= rotation = 再 register)。 ExternalId と違い
 * 「回さない」制約は無い (long-lived 鍵なので運用上 rotate を推奨)。 SSM は内部で version 履歴を保持する。
 */
export async function putSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
  credential: SakuraCredential,
): Promise<void> {
  const name = buildSakuraCredentialParameterName(deps.env, tenantId, teamSlug);
  await deps.ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: JSON.stringify({
        accessToken: credential.accessToken,
        accessTokenSecret: credential.accessTokenSecret,
      }),
      Type: ParameterType.SECURE_STRING,
      Overwrite: true,
      // KMS は AWS managed (alias/aws/ssm)。 明示 KeyId を渡さないと SSM が自動採用する (= コスト 0)。
    }),
  );
}

/**
 * team の Sakura API key を削除 (= revoke / team teardown)。 存在しない場合は no-op (= idempotent)。
 */
export async function deleteSakuraCredential(
  deps: SakuraCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<void> {
  const name = buildSakuraCredentialParameterName(deps.env, tenantId, teamSlug);
  try {
    await deps.ssm.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if (isParameterNotFound(err)) return;
    throw err;
  }
}
