import type { TeamRecord } from "../../../control-data/teams-repository.js";
import { slugify } from "../../deploy-handler/naming.js";
import { getAzureCredential } from "../../shared/azure-credential-store.js";
import {
  resolveVerifiedCompetitorAccount,
  type VerifiedCompetitorAccount,
} from "../../shared/competitor-account-lookup.js";
import { getGcpCredential } from "../../shared/gcp-credential-store.js";
import { AZURE_PROVIDER, GCP_PROVIDER, SAKURA_PROVIDER } from "../../shared/runtime/index.js";
import { getSakuraCredential } from "../../shared/sakura-credential-store.js";
import type { EventSharedResources } from "../shared.js";
import type { EventProblemTarget } from "../types.js";
import { NON_AWS_CLOUD_PROVIDERS } from "./types.js";

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

/**
 * [#2571] non-AWS single-provider (gcp/azure/sakura) の team × provider の credential
 * 登録有無を batch 解決する — `resolveBulkVerifiedAccounts` の非 AWS 版。 `plan-builder` は
 * ここで返った Set の存在有無だけを見る (実 credential 値は adapter dispatch 時に
 * `buildAdapterDependencies` が再解決するため、 plan 時点では existence だけで十分)。
 *
 * `shared.ssm` が未配線 (= scheduled reconciler 等、 staged enablement 未達の Lambda) なら
 * 空 Set を返し、 caller (plan-builder) の v1 `unsupportedRuntime` 拒否に委ねる。 選択された
 * 問題に非 AWS single-provider が 1 つも無ければ (= 全 AWS) 同じく空 Set (credential store
 * への無駄な SSM read を避ける)。
 */
export async function resolveBulkNonAwsCredentials(
  shared: EventSharedResources,
  tenantId: string,
  teams: readonly TeamRecord[],
  problems: readonly EventProblemTarget[],
): Promise<ReadonlySet<string>> {
  const ssm = shared.ssm;
  if (!ssm) return new Set();
  const providers = candidateNonAwsProviders(shared, problems);
  if (providers.size === 0) return new Set();

  const deps = { ssm, env: shared.env };
  const registered = new Set<string>();
  await Promise.all(
    teams.flatMap((team) =>
      Array.from(providers).map(async (provider) => {
        const teamSlug = slugify(team.internalSlug);
        if (await hasNonAwsCredential(provider, deps, tenantId, teamSlug)) {
          registered.add(`${provider}#${teamSlug}`);
        }
      }),
    ),
  );
  return registered;
}

function candidateNonAwsProviders(
  shared: EventSharedResources,
  problems: readonly EventProblemTarget[],
): Set<string> {
  const providers = new Set<string>();
  for (const problem of problems) {
    const runtime = shared.resolveProblemRuntimeDescriptor?.(problem.problemId);
    if (
      runtime !== undefined &&
      !("kind" in runtime) &&
      NON_AWS_CLOUD_PROVIDERS.includes(runtime.provider)
    ) {
      providers.add(runtime.provider);
    }
  }
  return providers;
}

function hasNonAwsCredential(
  provider: string,
  deps: { readonly ssm: NonNullable<EventSharedResources["ssm"]>; readonly env: string },
  tenantId: string,
  teamSlug: string,
): Promise<boolean> {
  if (provider === SAKURA_PROVIDER) {
    return getSakuraCredential(deps, tenantId, teamSlug).then((c) => c !== undefined);
  }
  if (provider === AZURE_PROVIDER) {
    return getAzureCredential(deps, tenantId, teamSlug).then((c) => c !== undefined);
  }
  if (provider === GCP_PROVIDER) {
    return getGcpCredential(deps, tenantId, teamSlug).then((c) => c !== undefined);
  }
  return Promise.resolve(false);
}
