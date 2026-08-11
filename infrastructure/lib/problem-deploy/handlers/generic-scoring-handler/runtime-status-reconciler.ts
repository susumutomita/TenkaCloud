import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import {
  type AdapterDependencyConfig,
  buildAdapterDependencies,
} from "../deploy-handler/adapter-dependencies.js";
import { slugify } from "../deploy-handler/naming.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  type ProblemRuntime,
  type RuntimeStatus,
  selectAdapter,
} from "../shared/runtime/index.js";
import { resolveDeploymentsRepository } from "./shared.js";

/**
 * [#1410-1412] 非 AWS runtime (sakura/azure/gcp) deployment の status reconciler。
 *
 * AWS は Step Functions State Machine が deploy 進捗を CFn から読み status / stackOutputs を書き戻すが、
 * 非 AWS は同期 adapter.deploy で enqueue するだけなので status を進める主体が無い。 本 reconciler は
 * generic-scoring の 1-min tick に相乗りし、 **active な非 AWS 行** (= runtimeProvider あり + status が
 * 非終端) を scan して adapter.getStatus で cloud 状態を読み、 DeploymentStatus に射影して書き戻す。
 * ready になったら adapter.collectOutputs で endpoint を stackOutputs に書き、 scoring が probe できるようにする。
 *
 * 既存行 (runtimeProvider 無し) / AWS 行は scan filter で除外され完全に従来どおり。 conditional update で
 * 並行 teardown 等との race を弾く (= 期待 status と一致するときだけ書く)。
 */

/** RuntimeStatus (adapter の 6-state) を DeploymentStatus に射影する。 */
export function mapRuntimeStatus(status: RuntimeStatus): DeploymentStatus {
  switch (status) {
    case "ready":
      return "COMPLETE";
    case "failed":
      return "FAILED";
    case "destroying":
      return "DELETING";
    case "destroyed":
      return "DELETED";
    default:
      // pending / deploying は IN_PROGRESS に倒す (= 採点 gate 前)。
      return "IN_PROGRESS";
  }
}

export interface RuntimeReconcileDeps {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly deploymentsTableName: string;
  readonly env: string;
  readonly events: EventBridgeClient;
  readonly eventBusName: string;
  readonly ssm: Pick<SSMClient, "send">;
  readonly sakuraAppRunBaseUrl?: string;
}

/** 行から runtime を復元 (= non-AWS のみ呼ばれる前提だが entry 欠落は undefined で skip)。 */
function runtimeFromItem(item: Partial<DeploymentItem>): ProblemRuntime | undefined {
  if (item.runtimeProvider && item.runtimeEngine && item.runtimeEntry) {
    return {
      provider: item.runtimeProvider,
      engine: item.runtimeEngine,
      entry: item.runtimeEntry,
    };
  }
  return undefined;
}

function adapterConfig(deps: RuntimeReconcileDeps, tenantId: string): AdapterDependencyConfig {
  return {
    env: deps.env,
    tenantId,
    events: deps.events,
    eventBusName: deps.eventBusName,
    ssm: deps.ssm,
    ...(deps.sakuraAppRunBaseUrl ? { sakuraAppRunBaseUrl: deps.sakuraAppRunBaseUrl } : {}),
  };
}

/**
 * 1 行を reconcile する。 getStatus で cloud 状態を読み、 変化があれば status を書き戻す。 ready なら
 * collectOutputs で endpoint を stackOutputs に書く。 conditional update で並行更新との race を弾く。
 */
export async function reconcileRuntimeDeployment(
  deps: RuntimeReconcileDeps,
  item: Partial<DeploymentItem>,
  nowIso: string,
): Promise<void> {
  const runtime = runtimeFromItem(item);
  if (!runtime) return;
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) return;
  const jobId = item.jobId;
  const tenantId = item.tenantId;
  const currentStatus = item.status;
  if (!jobId || !tenantId || !currentStatus) return;

  const adapter = selectAdapter(
    runtime,
    buildAdapterDependencies(
      adapterConfig(deps, tenantId),
      runtime,
      slugify(String(item.teamName ?? "")),
    ),
  );
  const statusInput = {
    jobId,
    namePrefix: String(item.namePrefix ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
  };
  const runtimeStatus = await adapter.getStatus(statusInput);
  const nextStatus = mapRuntimeStatus(runtimeStatus);

  // ready のときは endpoint を集めて stackOutputs に書く (= scoring が probe できる)。
  const outputs = runtimeStatus === "ready" ? await adapter.collectOutputs(statusInput) : undefined;
  const stackOutputs = outputs ? JSON.stringify(outputs) : undefined;

  // status も outputs も変化が無ければ書かない (= DDB write を抑える)。
  if (nextStatus === currentStatus && stackOutputs === undefined) return;

  await applyReconcileUpdate(deps, {
    jobId,
    tenantId,
    currentStatus,
    nextStatus,
    stackOutputs,
    nowIso,
  });
}

interface ReconcileUpdate {
  readonly jobId: string;
  readonly tenantId: string;
  readonly currentStatus: DeploymentStatus;
  readonly nextStatus: DeploymentStatus;
  readonly stackOutputs: string | undefined;
  readonly nowIso: string;
}

/**
 * status (+ ready なら stackOutputs) を conditional update で書き戻す。 並行 teardown / 他 tick との race は
 * 読み取り時 status と一致する condition で弾き、 ConditionalCheckFailed は次 tick へ委ねて throw しない。
 *
 * [Issue #2441 / Phase B2] `transitionRuntimeStatus` builds the identical
 * dynamic SET expression (`stackOutputs` appended only when defined) verbatim
 * inside the seam and folds the CCF into a `conflict` outcome instead of
 * throwing — discarding it here reproduces the pre-seam CCF-swallow.
 */
async function applyReconcileUpdate(deps: RuntimeReconcileDeps, u: ReconcileUpdate): Promise<void> {
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(deps);
  await repository.transitionRuntimeStatus(
    u.jobId,
    u.tenantId,
    u.currentStatus,
    u.nextStatus,
    u.stackOutputs,
    u.nowIso,
  );
}

/**
 * active な非 AWS deployment を scan して 1 件ずつ reconcile する。 generic-scoring の tick に相乗り。
 * 1 件の失敗は全体を止めない (= 次 tick で再評価)。 AWS 行 / runtimeProvider 無し行は filter で除外。
 */
export async function reconcileRuntimeStatuses(
  deps: RuntimeReconcileDeps,
  nowIso: string,
): Promise<void> {
  // [Issue #2441 / Phase B3] `forEachRuntimeReconcilablePage` absorbs the
  // 200-per-page Scan + `LastEvaluatedKey` drain into the Deployments seam; the
  // per-page `Promise.all` reconcile fan-out below stays unchanged.
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(deps);
  await repository.forEachRuntimeReconcilablePage(async (page) => {
    const items = page as Partial<DeploymentItem>[];
    await Promise.all(
      items.map((item) =>
        reconcileRuntimeDeployment(deps, item, nowIso).catch((err) => {
          console.warn("[runtime-reconciler] reconcile failed", {
            jobId: item.jobId,
            provider: item.runtimeProvider,
            message: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  });
}
