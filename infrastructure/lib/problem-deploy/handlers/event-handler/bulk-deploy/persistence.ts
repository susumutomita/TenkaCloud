import type {
  BulkDeploymentCreateEntry,
  DeploymentsLifecyclePort,
} from "../../../control-data/deployments-repository.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveEventRepositories,
} from "../shared.js";
import { type PlanEntry, type PublishFailure, TRANSACT_WRITE_BATCH } from "./types.js";

/**
 * Plan entries を DDB TransactWrite で chunk 単位に書き込む。 retry/forceRedeploy 経路では
 * 1 entry あたり Put + Delete の 2 ops、 通常経路は Put のみ。 chunk size は 25 ops 上限から
 * 逆算する。 Put は `attribute_not_exists(PK)` で同 jobId 重複を防ぐ。
 *
 * [Issue #2441 / Phase B2] Each chunk goes through the seam's
 * `createBulkDeployments` (the identical Put+Delete TransactWrite, built
 * verbatim inside the repository). The pre-seam `TransactWriteCommand` had no
 * try/catch: a `ConditionalCheck` failure (stale plan — a jobId collision, or a
 * `replacesJobId` row that changed tenant / was deleted between planning and
 * write) propagated as an uncaught `TransactionCanceledException`, surfacing to
 * the operator instead of silently dropping part of the plan. The seam folds
 * that into a `conflict` outcome rather than throwing, so `writeBulkDeployChunk`
 * re-throws on a non-`updated` outcome to keep that fail-loud contract.
 */
export async function writeBulkDeployPlan(
  shared: EventSharedResources,
  tenantId: string,
  plan: readonly PlanEntry[],
  replacesExisting: boolean,
): Promise<void> {
  const opsPerEntry = replacesExisting ? 2 : 1;
  const planPerChunk = Math.floor(TRANSACT_WRITE_BATCH / opsPerEntry);
  const repo: DeploymentsLifecyclePort = await resolveDeploymentsRepository(shared);
  const writes: Promise<void>[] = [];
  for (let index = 0; index < plan.length; index += planPerChunk) {
    writes.push(writeBulkDeployChunk(repo, tenantId, plan.slice(index, index + planPerChunk)));
  }
  await Promise.all(writes);
}

async function writeBulkDeployChunk(
  repo: DeploymentsLifecyclePort,
  tenantId: string,
  chunk: readonly PlanEntry[],
): Promise<void> {
  const entries: BulkDeploymentCreateEntry[] = chunk.map((entry) => ({
    record: entry.item,
    ...(entry.replacesJobId ? { replacesJobId: entry.replacesJobId } : {}),
  }));
  const outcome = await repo.createBulkDeployments(tenantId, entries);
  if (outcome.outcome !== "updated") {
    throw new Error(
      `bulk deploy plan write conflict for tenant=${tenantId} (a targeted row changed since planning)`,
    );
  }
}

/**
 * Event の status を DEPLOYING へ前進させる。 DRAFT / READY / DEPLOYING からのみ許可
 * (= ACTIVE / COMPLETE 等の後続状態を巻き戻さない)。 [#2437 Phase A2] 条件付き書き込みは
 * repository seam の `markDeploying(tenantId, eventId, at)` に移設 — 条件不成立は
 * conflict outcome として返り no-op (= 旧 ConditionalCheckFailed 握り潰しと同じ挙動)。
 * bulk-deploy は Teams table を必ず配線する (手動 route / scheduled deploy とも) ので、
 * mirror backend も効く runtime resolver 経由で解決する。
 */
export async function markBulkEventDeploying(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdAt: string,
): Promise<void> {
  const repositories = await resolveEventRepositories(shared);
  await repositories.events.markDeploying(tenantId, eventId, createdAt);
}

/**
 * Publish 失敗 deployment を FAILED に倒す。 PENDING からのみ遷移 (= 別経路で進んだ行を
 * 巻き戻さない)。 ConditionalCheckFailed は no-op (= 既に他経路で更新済み)。
 *
 * [Issue #2441 / Phase B2] `compensateBulkCreateToFailed` folds the CCF into a
 * `conflict` outcome instead of throwing — discarding it here reproduces the
 * pre-seam CCF-swallow; a genuine non-CCF error still throws from inside the
 * seam and propagates here unchanged.
 */
export async function markPublishFailuresFailed(
  shared: EventSharedResources,
  tenantId: string,
  failures: readonly PublishFailure[],
  updatedAt: string,
): Promise<void> {
  const repo: DeploymentsLifecyclePort = await resolveDeploymentsRepository(shared);
  await Promise.all(
    failures.map((failure) =>
      repo.compensateBulkCreateToFailed(
        failure.jobId,
        tenantId,
        `Failed to publish DeployCreateRequested event: ${failure.reason}`,
        updatedAt,
      ),
    ),
  );
}
