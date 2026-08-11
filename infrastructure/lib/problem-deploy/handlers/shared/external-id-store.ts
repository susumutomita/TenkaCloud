import { randomBytes } from "node:crypto";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterType,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { isParameterNotFound, isParameterVersionNotFound } from "./ssm-parameter.js";

/**
 * SSM Parameter Store SecureString ベースの per-tenant ExternalId ストア
 * (Issue #459)。
 *
 * path 規約: `/{env}/tenants/{tenantId}/external-id`
 *   - 1 tenant 1 値 (Decision 1 = A2 と整合: 同 tenant 配下の複数 competitor account は同じ ExternalId を共有)
 *   - KMS は AWS managed (`alias/aws/ssm`、コスト 0)
 *   - tenantId を path 末端より前に置き、IAM policy で path prefix 絞り込みを行う
 *
 * `secrets-manager-forbidden` enforcement と整合: Secrets Manager は使わない。
 */

/** SSM の許容 char class (`[A-Za-z0-9_=,.@:/-]`) + 長さ要件を満たす 64 文字の random hex。 */
const EXTERNAL_ID_BYTE_LENGTH = 32; // hex 化で 64 文字 → competitor-bootstrap.yaml の MaxLength=128 内、MinLength=16 を満たす

// ParameterNotFound / ParameterVersionNotFound 判定は shared/ssm-parameter.ts に集約 (= Sakura key store と共有、 DRY)。

export function buildExternalIdParameterName(env: string, tenantId: string): string {
  // env / tenantId は POSIX 風 path の segment に直接埋めるため、許容 charclass の事前 sanitize は caller 側責任。
  // 実運用では env={development,staging,production}, tenantId は ULID なので問題なし。
  return `/${env}/tenants/${tenantId}/external-id`;
}

export function buildExternalIdParameterArnPattern(
  region: string,
  account: string,
  env: string,
): string {
  // IAM policy 用。tenantId を `*` でワイルドカード化する (= deploy 時点では具体 tenantId を知らない)。
  return `arn:aws:ssm:${region}:${account}:parameter/${env}/tenants/*/external-id`;
}

/**
 * `randomBytes(32).toString("hex")` で 64 文字の hex を生成。
 * `competitor-bootstrap.yaml` の `AllowedPattern: ^[A-Za-z0-9_=,.@:/-]+$` を満たす。
 */
export function generateExternalId(): string {
  return randomBytes(EXTERNAL_ID_BYTE_LENGTH).toString("hex");
}

export interface ExternalIdStoreDeps {
  readonly ssm: Pick<SSMClient, "send">;
  readonly env: string;
}

/**
 * tenant の ExternalId を取得。未登録なら `undefined` を返す (= not found を上位で 404 等に変換する余地を残す)。
 */
export async function getExternalId(
  deps: ExternalIdStoreDeps,
  tenantId: string,
): Promise<string | undefined> {
  const name = buildExternalIdParameterName(deps.env, tenantId);
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return out.Parameter?.Value;
  } catch (err) {
    if (isParameterNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * tenant の ExternalId を **現 version 番号付き** で取得 (Phase 3.2 / Issue #603)。
 *
 * `GetParameter` は `Parameter.Version` を返すので、それを caller に伝えて grace fallback
 * (= version-1 で再取得) に使う。version は 1 起点で `Overwrite: true` 毎にインクリメント
 * される (= SSM 仕様)。
 *
 * 未登録は `undefined`。`isParameterNotFound` で吸収する点は `getExternalId` と同じ。
 */
export async function getExternalIdWithVersion(
  deps: ExternalIdStoreDeps,
  tenantId: string,
): Promise<{ readonly value: string; readonly version: number } | undefined> {
  const name = buildExternalIdParameterName(deps.env, tenantId);
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = out.Parameter?.Value;
    const version = out.Parameter?.Version;
    if (typeof value !== "string" || typeof version !== "number") return undefined;
    return { value, version };
  } catch (err) {
    if (isParameterNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * 旧 version の ExternalId を取得 (Phase 3.2 grace fallback / Issue #603)。
 *
 * `SSM` は `Name` に `:<version>` を付けると pinned version の値を返す。1 generation 前まで
 * しか fallback しない (= AGENTS.md の指針: 旧値 long tail で grace を引き伸ばさない)。
 *
 * `version <= 0` (= 直前 version が存在しない、= rotate 未経験) なら `undefined`。
 * `ParameterVersionNotFound` (= 100 version cap で auto-drop 済) も `undefined` 扱い。
 */
export async function getExternalIdByVersion(
  deps: ExternalIdStoreDeps,
  tenantId: string,
  version: number,
): Promise<string | undefined> {
  if (!Number.isInteger(version) || version <= 0) return undefined;
  const name = `${buildExternalIdParameterName(deps.env, tenantId)}:${version}`;
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return out.Parameter?.Value;
  } catch (err) {
    if (isParameterNotFound(err)) return undefined;
    // ParameterVersionNotFound: SSM が 100 version cap で auto-drop 済 (= 旧 version が消えた)。
    if (isParameterVersionNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * tenant の ExternalId が無ければ生成 + Put して返す。既存なら既存値を返す (= 冪等)。
 *
 * 「Add account」を 2 回目以降に押しても ExternalId は **回さない**。
 */
export async function ensureExternalId(
  deps: ExternalIdStoreDeps,
  tenantId: string,
): Promise<{ readonly externalId: string; readonly created: boolean }> {
  const existing = await getExternalId(deps, tenantId);
  if (existing) return { externalId: existing, created: false };
  const name = buildExternalIdParameterName(deps.env, tenantId);
  const externalId = generateExternalId();
  await deps.ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: externalId,
      Type: ParameterType.SECURE_STRING,
      Overwrite: false,
      // KMS は AWS managed (alias/aws/ssm)。明示 KeyId を渡さない場合に SSM が自動採用する。
    }),
  );
  return { externalId, created: true };
}

/**
 * tenant の ExternalId を削除。存在しない場合は no-op (= idempotent)。
 *
 * 注意: 同 tenant 配下に **他の verified account が残っている場合は呼ぶべきでない** (= caller 責任)。
 * 本関数は SSM API 側で他の account の参照を確認する手段が無いため、削除の判断は handler 側で行う。
 */
export async function deleteExternalId(deps: ExternalIdStoreDeps, tenantId: string): Promise<void> {
  const name = buildExternalIdParameterName(deps.env, tenantId);
  try {
    await deps.ssm.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if (isParameterNotFound(err)) return;
    throw err;
  }
}
