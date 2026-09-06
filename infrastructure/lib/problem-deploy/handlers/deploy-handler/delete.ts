import type {
  DeploymentsCoordinationPort,
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import { resolveCoordinationArtifactStore } from "../shared/coordination-artifact-store.js";
import { cleanupCoordinationStateIfLastDeployment } from "../shared/coordination-cleanup.js";
import { deploymentTerminalExpiresAt } from "../shared/deployment-retention.js";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  type ProblemRuntime,
  resolveItemRuntime,
  selectAdapter,
} from "../shared/runtime/index.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { buildAdapterDependencies } from "./adapter-dependencies.js";
import type { DeploySharedResources } from "./deploy.js";
import { slugify } from "./naming.js";
import { resolveDeploymentsRepository } from "./shared.js";
import type { DeploymentItem, DeploymentStatus } from "./types.js";

export type TeardownOutcome =
  | { kind: "accepted"; previousStatus: DeploymentStatus }
  | { kind: "not_found" }
  | { kind: "already_deleted" }
  | { kind: "race"; reason: "tenant_or_status_mismatch" }
  | { kind: "missing_required_fields"; fields: readonly string[] };

/**
 * 手動 teardown を要求する。status を DELETING に倒して `DeployDeleteRequested` を
 * EventBridge に publish するだけ (実 CFn DeleteStack は State Machine 経由で非同期実行)。
 * publish 失敗時は status を FAILED に巻き戻す: DELETING のまま放置すると次の呼び出しが
 * `already_deleted` で no-op を返して CFn stack が orphan 化するため。
 *
 * `tenantId` mismatch は `not_found` を返してクロステナント漏洩を防ぐ。必須フィールド
 * (region / awsAccountId / stackName) の欠損は `missing_required_fields` で並行更新
 * (`race`) とは区別する (corruption 検出シグナル)。
 */
export async function requestTeardown(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  nowMs: number,
): Promise<TeardownOutcome> {
  const deploymentsRepository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(shared);
  const item = (await deploymentsRepository.getDeployment(jobId)) as
    | Partial<DeploymentItem>
    | undefined;
  if (!item) return { kind: "not_found" };
  if (item.tenantId !== tenantId) return { kind: "not_found" };
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (status === "DELETING" || status === "DELETED") return { kind: "already_deleted" };

  // [#1410-1412] 非 AWS runtime (sakura/azure/gcp) は CFn DeleteStack ではなく
  // adapter.destroy (cloud REST) で teardown する。 runtimeProvider が無い行は従来どおり AWS/CFn 経路。
  const runtime = resolveItemRuntime(item);
  if (runtime.provider !== EXECUTABLE_PROVIDER || runtime.engine !== EXECUTABLE_ENGINE) {
    return teardownViaAdapter(shared, tenantId, jobId, item, runtime, status, nowMs);
  }

  const region = String(item.region ?? "");
  const awsAccountId = String(item.awsAccountId ?? "");
  // CFn StackName は namePrefix で十分 (StackId は不要、State Machine 側で region 指定して
  // delete-stack するときも namePrefix で identify できる)。stackId が無い場合 (PENDING で
  // 削除した場合) でも namePrefix は deploy 時に必ず確定している。
  // #1810: FAILED deployment は stack ARN 記録前に終わると stackId="" (空文字) になる。
  // `??` は空文字を fallback しないので `||` で namePrefix に倒す (= 失敗 deployment の
  // teardown が missing_required_fields で弾かれて手動削除すら不能になるのを防ぐ)。
  const stackName = String(item.stackId || item.namePrefix || "");

  const missing = missingTeardownFields({ region, awsAccountId, stackName });
  if (missing.length > 0) {
    return { kind: "missing_required_fields", fields: missing };
  }

  const updatedAt = new Date(nowMs).toISOString();
  const transition = await transitionTeardownToDeleting(shared, tenantId, jobId, updatedAt, nowMs);
  if (transition) return transition;

  // Phase 2.2 (Issue #459): delete も cross-account 化。verified=true 行が見つかった
  // 場合のみ AssumeRole 用 metadata を詰める (= 旧 deployment 行で competitor が未登録の
  // ケースは undefined のまま — CodeBuild は同 account 経路に倒れる)。
  const verified = await resolveVerifiedCompetitorAccount(
    {
      runtime: shared.runtime,
      ddb: shared.ddb,
      competitorAccountsTableName: shared.competitorAccountsTableName,
      env: shared.env,
    },
    tenantId,
    awsAccountId,
  );

  const detail: DeployDeleteRequestedDetail = {
    jobId,
    correlationId: jobId,
    tenantId,
    stackName,
    region,
    awsAccountId,
    competitorRoleArn: verified?.competitorRoleArn,
    externalIdParameterName: verified?.externalIdParameterName,
  };
  await publishTeardown(shared, tenantId, nowMs, detail);
  await cleanupCoordinationStateAfterTeardown(shared, tenantId, item);

  return { kind: "accepted", previousStatus: status };
}

/**
 * [#1410-1412] 非 AWS runtime の teardown。 status を DELETING に倒し、 adapter.destroy で
 * cloud REST 削除を enqueue する (EventBridge / CFn は使わない)。 DELETED への最終遷移は status polling
 * (adapter.getStatus → destroyed) が確定する想定 (= AWS の State Machine 確定と同じ非同期セマンティクス)。
 * adapter.destroy 失敗時は DELETING → FAILED に巻き戻す (= AWS publish 失敗時と同じ補償)。
 */
async function teardownViaAdapter(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  item: Partial<DeploymentItem>,
  runtime: ProblemRuntime,
  previousStatus: DeploymentStatus,
  nowMs: number,
): Promise<TeardownOutcome> {
  const updatedAt = new Date(nowMs).toISOString();
  const transition = await transitionTeardownToDeleting(shared, tenantId, jobId, updatedAt, nowMs);
  if (transition) return transition;

  const teamSlug = slugify(String(item.teamName ?? ""));
  const adapter = selectAdapter(
    runtime,
    buildAdapterDependencies({ ...shared, tenantId }, runtime, teamSlug),
  );
  try {
    await adapter.destroy({
      jobId,
      namePrefix: String(item.namePrefix ?? ""),
      region: String(item.region ?? ""),
      awsAccountId: String(item.awsAccountId ?? ""),
    });
  } catch (err) {
    await compensateFailedTeardownPublish(
      shared,
      tenantId,
      jobId,
      nowMs,
      `Failed to destroy ${runtime.provider}/${runtime.engine} runtime`,
    );
    throw err;
  }
  logDeployTrace("deploy.delete.adapter.enqueued", {
    jobId,
    correlationId: jobId,
    tenantId,
    provider: runtime.provider,
    engine: runtime.engine,
    namePrefix: String(item.namePrefix ?? ""),
  });
  await cleanupCoordinationStateAfterTeardown(shared, tenantId, item);
  return { kind: "accepted", previousStatus };
}

function missingTeardownFields(fields: {
  readonly region: string;
  readonly awsAccountId: string;
  readonly stackName: string;
}): string[] {
  return (Object.entries(fields) as Array<[string, string]>)
    .filter(([, value]) => !value)
    .map(([field]) => field);
}

async function transitionTeardownToDeleting(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  updatedAt: string,
  nowMs: number,
): Promise<Extract<TeardownOutcome, { kind: "race" }> | undefined> {
  // Issue #1200: DELETING に遷移したタイミングで expiresAt を 7 日 retention に refresh する
  // (= teardown が成功して DELETED に最終遷移するまでに competition session TTL (8h) が
  // 切れて DDB から消える事故を防ぐ。 DELETING 中の audit trail を保護する)。
  // Issue #2019: APPROVAL_PENDING is a held, deletable state — an operator rejecting a
  // held deploy must be able to tear it down (its CFn stack was never created, so the
  // DeleteStack the worker issues is a no-op, transitioning the row cleanly to DELETED).
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(shared);
  const outcome = await repository.markDeleting(
    jobId,
    tenantId,
    updatedAt,
    deploymentTerminalExpiresAt(nowMs),
  );
  if (outcome.outcome === "conflict") {
    return { kind: "race", reason: "tenant_or_status_mismatch" };
  }
  return undefined;
}

/**
 * [Issue #3149] Best-effort coordination cleanup after a deployment enters
 * teardown. Run only after cloud deletion was dispatched, so a slow cleanup
 * backend cannot strand resources behind a deployment already marked DELETING.
 *
 * Best-effort in the same sense as event teardown's own cleanup
 * (`bulk-delete.ts`): the teardown itself has already been accepted and a
 * CloudFormation stack is about to be deleted. Failing the caller here would
 * report that the teardown did not happen when it did, and would leave the
 * operator unable to tell a leaked stack — real resources, real money — from a
 * leaked state row, which is bytes and which the row's own TTL still reaps.
 *
 * The failure is logged rather than swallowed.
 */
async function cleanupCoordinationStateAfterTeardown(
  shared: DeploySharedResources,
  tenantId: string,
  item: Partial<DeploymentItem>,
): Promise<void> {
  try {
    const repository: DeploymentsQueryPort & DeploymentsCoordinationPort =
      await resolveDeploymentsRepository(shared);
    const outcome = await cleanupCoordinationStateIfLastDeployment(
      { repository, artifacts: resolveCoordinationArtifactStore() },
      {
        tenantId,
        eventId: item.eventId,
        problemId: item.problemId,
        // The row this teardown just marked is read back from the event listing
        // inside the cleanup, so its own status is not passed here — passing the
        // pre-teardown snapshot would count a row that can no longer act.
      },
    );
    if (outcome.kind === "deleted") {
      logDeployTrace("deploy.delete.coordination.cleaned", {
        tenantId,
        eventId: item.eventId,
        problemIds: item.problemId,
      });
    }
  } catch (err) {
    logDeployTrace("deploy.delete.coordination.cleanup-failed", {
      tenantId,
      eventId: item.eventId,
      problemIds: item.problemId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

async function publishTeardown(
  shared: DeploySharedResources,
  tenantId: string,
  nowMs: number,
  detail: DeployDeleteRequestedDetail,
): Promise<void> {
  try {
    await publishProblemEvent({
      client: shared.events,
      busName: shared.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
      jobId: detail.jobId,
      detail,
    });
    logDeployTrace("deploy.delete.enqueued", detail);
  } catch (err) {
    await compensateFailedTeardownPublish(shared, tenantId, detail.jobId, nowMs);
    throw err;
  }
}

async function compensateFailedTeardownPublish(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  nowMs: number,
  reason = "Failed to publish DeployDeleteRequested event",
): Promise<void> {
  try {
    // Issue #1200: FAILED 化のタイミングで expiresAt を 7 日 retention に refresh。
    const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
      await resolveDeploymentsRepository(shared);
    await repository.compensateDeleteToFailed(
      jobId,
      tenantId,
      reason,
      new Date(nowMs).toISOString(),
      deploymentTerminalExpiresAt(nowMs),
    );
  } catch {
    // best-effort: compensation 失敗は黙って捨て、元の publish エラーを表に出す
  }
}
