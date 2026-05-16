import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { getExternalIdByVersion, getExternalIdWithVersion } from "../shared/external-id-store.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import {
  CompetitorAccountNotFoundError,
  getCompetitorAccount,
  markCompetitorAccountVerified,
} from "./store.js";
import type { CompetitorAccountSummary } from "./types.js";

export class ExternalIdMissingError extends Error {
  constructor(public readonly tenantId: string) {
    super(`external id parameter is missing for tenant ${tenantId}`);
    this.name = "ExternalIdMissingError";
  }
}

export class AssumeRoleSanityCheckFailedError extends Error {
  constructor(
    public readonly awsAccountId: string,
    public readonly underlyingErrorName: string,
    underlyingMessage: string,
  ) {
    super(`AssumeRole sanity check failed: ${underlyingErrorName}: ${underlyingMessage}`);
    this.name = "AssumeRoleSanityCheckFailedError";
  }
}

export interface VerifyCompetitorAccountContext {
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly nowMs: number;
}

const SANITY_CHECK_SESSION_NAME = "TenkaCloud-CompetitorAccount-Verify";
// 最短 session 長 (= STS の最小値)。verify は credentials を実際に使わないので即破棄で良い。
const MIN_ASSUME_ROLE_SESSION_SECONDS = 900;

/**
 * Issue #856: rotate 直後の race で AssumeRole が AccessDenied / ExternalIdMismatch を返した
 * とき、 1 generation 前の ExternalId で 1 回だけ retry する。
 *
 * race scenario:
 *   1. operator が rotate を叩く → SSM v=N+1 へ
 *   2. verify が `$LATEST` から v=N+1 を読む
 *   3. competitor 側 Trust Policy は v=N (まだ反映していない)
 *   4. AssumeRole fails (= ExternalId mismatch)
 *   5. v=N を fallback で読み直して 1 回だけ retry → 成功すれば pass
 *
 * version <= 1 のとき fallback 不可。 100 version cap で auto-drop 済の場合も undefined。
 */
const ASSUME_ROLE_FALLBACK_ERROR_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "Forbidden",
]);

function shouldRetryWithPreviousVersion(errorName: string): boolean {
  return ASSUME_ROLE_FALLBACK_ERROR_NAMES.has(errorName);
}

/**
 * `(tenantId, awsAccountId)` の競技者 IAM Role に対して STS AssumeRole を 1 度だけ発行し
 * (= ExternalId 付き、最短 15 分 session)、成功なら DDB の `verified=true` を立てる。
 *
 * 失敗ケース:
 *   - row が無い → `CompetitorAccountNotFoundError` (404 等価)
 *   - SSM に ExternalId が無い → `ExternalIdMissingError` (= 不整合、500 等価)
 *   - STS AssumeRole が失敗 → `AssumeRoleSanityCheckFailedError`
 *     (= ErrorName: AccessDenied / ExternalIdMismatch / etc. を operator に伝える)
 *
 * 注意: STS は 4xx を `name` 属性で示す (`AccessDenied` / `Forbidden` 等)。caller (handler) で
 * `error.underlyingErrorName` を見て operator にユーザフレンドリ表示する。
 */
export async function verifyCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  ctx: VerifyCompetitorAccountContext,
): Promise<CompetitorAccountSummary> {
  // DDB Get と SSM GetParameter は互いに独立 (= tenantId / awsAccountId が確定済) なので並列発火。
  // Issue #856: rotate 直後の race を吸収するため version 番号も取得する。
  const externalIdDeps = { ssm: shared.ssm, env: shared.env };
  const [account, externalIdWithVersion] = await Promise.all([
    getCompetitorAccount(shared, ctx.tenantId, ctx.awsAccountId),
    getExternalIdWithVersion(externalIdDeps, ctx.tenantId),
  ]);
  if (!account) throw new CompetitorAccountNotFoundError(ctx.awsAccountId);
  if (!externalIdWithVersion) throw new ExternalIdMissingError(ctx.tenantId);

  const roleArn = `arn:aws:iam::${ctx.awsAccountId}:role/${account.competitorRoleName}`;
  const sts = shared.sts as STSClient;

  const tryAssumeRole = async (externalId: string): Promise<void> => {
    await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: SANITY_CHECK_SESSION_NAME,
        ExternalId: externalId,
        DurationSeconds: MIN_ASSUME_ROLE_SESSION_SECONDS,
      }),
    );
  };

  try {
    await tryAssumeRole(externalIdWithVersion.value);
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "Unknown";
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Issue #856: rotate race grace fallback。 1 generation 前の ExternalId を 1 回だけ retry。
    if (shouldRetryWithPreviousVersion(errorName) && externalIdWithVersion.version > 1) {
      const previousExternalId = await getExternalIdByVersion(
        externalIdDeps,
        ctx.tenantId,
        externalIdWithVersion.version - 1,
      );
      if (previousExternalId) {
        try {
          await tryAssumeRole(previousExternalId);
          // grace fallback 成功: 旧 version で AssumeRole が通ったので verify 完了扱い。
          return markCompetitorAccountVerified(shared, {
            tenantId: ctx.tenantId,
            awsAccountId: ctx.awsAccountId,
            verifiedAt: new Date(ctx.nowMs).toISOString(),
          });
        } catch (retryErr) {
          const retryName = retryErr instanceof Error ? retryErr.name : "Unknown";
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new AssumeRoleSanityCheckFailedError(ctx.awsAccountId, retryName, retryMessage);
        }
      }
    }

    throw new AssumeRoleSanityCheckFailedError(ctx.awsAccountId, errorName, errorMessage);
  }

  return markCompetitorAccountVerified(shared, {
    tenantId: ctx.tenantId,
    awsAccountId: ctx.awsAccountId,
    verifiedAt: new Date(ctx.nowMs).toISOString(),
  });
}
