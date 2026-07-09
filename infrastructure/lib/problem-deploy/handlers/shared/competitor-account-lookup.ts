import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import { buildExternalIdParameterName } from "./external-id-store.js";

/**
 * `CompetitorAccounts` 行から「verified=true 行のみ」を引く lookup (Issue #459 Phase 2.2 /
 * [Issue #2442 Phase C2] repository seam 経由)。
 *
 * Worker 経路 (= bulk-deploy / single-deploy / stack-progress) が deploy 前に呼ぶ。
 * 戻り値が `null` の場合は 「verified=true な行が存在しない」 = backend で reject すべき。
 *
 * 本 helper は次の正本 (= single source of truth) を担う:
 *   - `(tenantId, awsAccountId)` の検証 (verified=true)
 *   - `competitorRoleName` の解決 (= AssumeRole 対象 Role 名)
 *   - SSM SecureString path の構築 (= caller が CodeBuild env 等に渡す)
 *
 * **ExternalId は SSM から fetch しない** — caller (Worker / CodeBuild script) が必要な
 * 時に SSM SecureString を直接読む。Lambda 側で plain text を返り値に乗せると、不必要に
 * 漏洩経路が増える (= 同 Lambda の他の error log / response にも露出するリスク)。
 *
 * 生の DDB access はここには無い — `controlDataRuntime.resolveCompetitorAccountsRepository`
 * 経由で {@link DynamoDbCompetitorAccountsRepository} (default) /
 * {@link SqlCompetitorAccountsRepository} (Turso/D1) を解決する。
 */
export interface CompetitorAccountResolveDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly competitorAccountsTableName: string;
  readonly env: string;
}

export interface VerifiedCompetitorAccount {
  readonly awsAccountId: string;
  readonly competitorRoleName: string;
  readonly region: string;
  /** SSM SecureString path (= `/<env>/tenants/<tenantId>/external-id`)。 */
  readonly externalIdParameterName: string;
  /**
   * AssumeRole 対象の RoleArn (= `arn:aws:iam::<awsAccountId>:role/<competitorRoleName>`)。
   * caller (CodeBuild env / STS client) は本値をそのまま使う。
   */
  readonly competitorRoleArn: string;
}

/**
 * verified=true な競技者 account を解決して返す。verified=false / 未登録なら `null`。
 *
 * caller の呼び出しパターン:
 *   const verified = await resolveVerifiedCompetitorAccount(deps, tenantId, awsAccountId);
 *   if (!verified) throw new UnverifiedCompetitorAccountError(awsAccountId);
 */
export async function resolveVerifiedCompetitorAccount(
  deps: CompetitorAccountResolveDeps,
  tenantId: string,
  awsAccountId: string,
): Promise<VerifiedCompetitorAccount | null> {
  const repository = await controlDataRuntime.resolveCompetitorAccountsRepository({
    ddb: deps.ddb as DynamoDBDocumentClient,
    competitorAccountsTableName: deps.competitorAccountsTableName,
  });
  const record = await repository.getAccount(tenantId, awsAccountId);
  if (!record) return null;
  if (record.verified !== true) return null;
  const competitorRoleName = String(record.competitorRoleName ?? "");
  if (!competitorRoleName) return null;
  const region = String(record.region ?? "");
  const externalIdParameterName = buildExternalIdParameterName(deps.env, tenantId);
  return {
    awsAccountId,
    competitorRoleName,
    region,
    externalIdParameterName,
    competitorRoleArn: `arn:aws:iam::${awsAccountId}:role/${competitorRoleName}`,
  };
}
