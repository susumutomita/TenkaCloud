import type { TeamDeploymentRecord } from "../../../control-data/teams-repository.js";
import { slugify } from "../../deploy-handler/naming.js";
import {
  resolveVerifiedCompetitorAccount,
  type VerifiedCompetitorAccount,
} from "../../shared/competitor-account-lookup.js";
import { NON_AWS_CONFIG_GETTERS } from "../../shared/non-aws-credential-getters.js";
import { isReservedRuntime, type ReservedProvider } from "../../shared/runtime/index.js";
import type { EventSharedResources } from "../shared.js";
import type { EventProblemTarget } from "../types.js";
import { nonAwsCredentialKey } from "./types.js";

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
  teams: readonly TeamDeploymentRecord[],
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
  teams: readonly TeamDeploymentRecord[],
  problems: readonly EventProblemTarget[],
): Set<string> {
  const ids = new Set<string>();
  for (const team of teams) if (team.awsAccountId) ids.add(team.awsAccountId);
  for (const problem of problems)
    if (problem.defaultAwsAccountId) ids.add(problem.defaultAwsAccountId);
  return ids;
}

/**
 * [#2571 review-fix] Fan-out concurrency cap for the per-(provider, team) SSM
 * `GetParameter` reads below. SSM's `GetParameter` default quota is roughly
 * 40 TPS per account/region — a large event (many teams × providers) firing
 * every pair as one unbounded `Promise.all` could burst well past that and
 * throw `ThrottlingException`; since that's a genuine (non-`ParameterNotFound`)
 * SSM error it rethrows and would reject the *whole* bulk deploy over a single
 * pair. Chunking the fan-out into small sequential batches keeps concurrency
 * bounded (and stays well inside a Lambda's timeout even for a large event)
 * without going fully sequential — it only lowers the odds of hitting the
 * limit, it does not change what a genuine SSM error does (still rethrows).
 */
const SSM_FAN_OUT_CHUNK_SIZE = 8;

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
  teams: readonly TeamDeploymentRecord[],
  problems: readonly EventProblemTarget[],
): Promise<ReadonlySet<string>> {
  const ssm = shared.ssm;
  if (!ssm) return new Set();
  const providers = candidateNonAwsProviders(shared, problems);
  if (providers.size === 0) return new Set();

  const deps = { ssm, env: shared.env };
  // [#2571 review-fix] `slugify` is a pure transform of `team.internalSlug`
  // alone (does not depend on `provider`) — hoisted out of the per-provider
  // inner closure so it runs once per team instead of once per (team,
  // provider) pair.
  const pairs = teams.flatMap((team) => {
    const teamSlug = slugify(team.internalSlug);
    return Array.from(providers).map((provider) => ({ provider, teamSlug }));
  });

  const registered = new Set<string>();
  for (let i = 0; i < pairs.length; i += SSM_FAN_OUT_CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + SSM_FAN_OUT_CHUNK_SIZE);
    await Promise.all(
      chunk.map(async ({ provider, teamSlug }) => {
        if (await hasNonAwsCredential(provider, deps, tenantId, teamSlug)) {
          registered.add(nonAwsCredentialKey(provider, teamSlug));
        }
      }),
    );
  }
  return registered;
}

function candidateNonAwsProviders(
  shared: EventSharedResources,
  problems: readonly EventProblemTarget[],
): Set<string> {
  const providers = new Set<string>();
  for (const problem of problems) {
    const runtime = shared.resolveProblemRuntimeDescriptor?.(problem.problemId);
    // [#2571 review-fix] `isReservedRuntime` checks the exact (provider, engine)
    // pair — the same predicate `plan-builder.ts`'s `classifyBulkRuntimeDispatch`
    // gate uses (#2562) — instead of the removed hand-written
    // `NON_AWS_CLOUD_PROVIDERS.includes(runtime.provider)` (provider-only) check,
    // so the two call sites cannot drift on what counts as a "non-AWS adapter"
    // runtime.
    if (runtime !== undefined && !("kind" in runtime) && isReservedRuntime(runtime)) {
      providers.add(runtime.provider);
    }
  }
  return providers;
}

/**
 * [#2571 review-fix] Getter dispatch via the shared `NON_AWS_CONFIG_GETTERS`
 * map (also used by `composite-target-connection.ts`) keyed by
 * {@link ReservedProvider}, replacing an if-chain that ended in an unreachable
 * `return Promise.resolve(false)` fallback (`provider` only ever reached that
 * branch for a value `candidateNonAwsProviders` never produces, since it
 * already filters through `isReservedRuntime`).
 *
 * `provider` arriving here having *not* passed `isReservedRuntime` upstream
 * would mean a genuine programming error (a provider added to
 * `RESERVED_RUNTIMES` without a matching `NON_AWS_CONFIG_GETTERS` entry, or a
 * future caller bypassing the gate) — fail loud instead of silently reporting
 * "no credential registered" (AGENTS.md "no silent fallbacks via mocks / stubs
 * / empty-array returns"). Exported (only) so the fail-loud contract itself
 * can be unit-tested directly — `resolveBulkNonAwsCredentials`'s own
 * `candidateNonAwsProviders` gate makes the throw unreachable through the
 * public `resolveBulkNonAwsCredentials` entrypoint.
 */
export async function hasNonAwsCredential(
  provider: string,
  deps: { readonly ssm: NonNullable<EventSharedResources["ssm"]>; readonly env: string },
  tenantId: string,
  teamSlug: string,
): Promise<boolean> {
  if (!isKnownNonAwsProvider(provider)) {
    throw new Error(
      `unknown non-AWS provider "${provider}" (expected one of: ${Object.keys(NON_AWS_CONFIG_GETTERS).join(", ")})`,
    );
  }
  const credential = await NON_AWS_CONFIG_GETTERS[provider](deps, tenantId, teamSlug);
  return credential !== undefined;
}

function isKnownNonAwsProvider(provider: string): provider is ReservedProvider {
  return provider in NON_AWS_CONFIG_GETTERS;
}
