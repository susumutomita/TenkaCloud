import type { TeamRecord } from "../../../control-data/teams-repository.js";
import {
  resolveVerifiedCompetitorAccount,
  type VerifiedCompetitorAccount,
} from "../../shared/competitor-account-lookup.js";
import type { EventSharedResources } from "../shared.js";
import type { EventProblemTarget } from "../types.js";

/**
 * teams × problems から候補 awsAccountId を抽出し、 CompetitorAccounts table を引いて
 * verified=true の record だけを `Map<accountId, VerifiedCompetitorAccount>` で返す。
 *
 * Phase 2.2 (Issue #459): verified=false / 未登録は plan 生成時に `unverified` 計上され
 * deployment 行は作らない (= ExternalId 取得経路を持たないため deploy 不可)。
 */
export async function resolveBulkVerifiedAccounts(
  shared: EventSharedResources,
  tenantId: string,
  teams: readonly TeamRecord[],
  problems: readonly EventProblemTarget[],
): Promise<Map<string, VerifiedCompetitorAccount>> {
  const accountIds = candidateBulkAccountIds(teams, problems);
  const verified = new Map<string, VerifiedCompetitorAccount>();
  await Promise.all(
    Array.from(accountIds).map(async (accountId) => {
      const account = await resolveVerifiedCompetitorAccount(
        {
          runtime: shared.runtime,
          ddb: shared.ddb,
          competitorAccountsTableName: shared.competitorAccountsTableName,
          env: shared.env,
        },
        tenantId,
        accountId,
      );
      if (account) verified.set(accountId, account);
    }),
  );
  return verified;
}

function candidateBulkAccountIds(
  teams: readonly TeamRecord[],
  problems: readonly EventProblemTarget[],
): Set<string> {
  const ids = new Set<string>();
  for (const team of teams) if (team.awsAccountId) ids.add(team.awsAccountId);
  for (const problem of problems)
    if (problem.defaultAwsAccountId) ids.add(problem.defaultAwsAccountId);
  return ids;
}
