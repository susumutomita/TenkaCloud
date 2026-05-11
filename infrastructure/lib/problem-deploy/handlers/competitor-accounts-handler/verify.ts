import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { getExternalId } from "../shared/external-id-store.js";
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
  const account = await getCompetitorAccount(shared, ctx.tenantId, ctx.awsAccountId);
  if (!account) throw new CompetitorAccountNotFoundError(ctx.awsAccountId);

  const externalId = await getExternalId({ ssm: shared.ssm, env: shared.env }, ctx.tenantId);
  if (!externalId) throw new ExternalIdMissingError(ctx.tenantId);

  const roleArn = `arn:aws:iam::${ctx.awsAccountId}:role/${account.competitorRoleName}`;
  try {
    await (shared.sts as STSClient).send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: SANITY_CHECK_SESSION_NAME,
        ExternalId: externalId,
        // 最短 15 分。verify は credentials を実際に使わないので即破棄して良い。
        DurationSeconds: 900,
      }),
    );
  } catch (err) {
    const underlyingErrorName = err instanceof Error ? err.name : "Unknown";
    const underlyingMessage = err instanceof Error ? err.message : String(err);
    throw new AssumeRoleSanityCheckFailedError(
      ctx.awsAccountId,
      underlyingErrorName,
      underlyingMessage,
    );
  }

  return markCompetitorAccountVerified(shared, {
    tenantId: ctx.tenantId,
    awsAccountId: ctx.awsAccountId,
    verifiedAt: new Date(ctx.nowMs).toISOString(),
  });
}
