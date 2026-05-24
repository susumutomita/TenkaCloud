import { type EventSharedResources, queryDeploymentsByEvent } from "../shared.js";
import type { BulkDeployRequest } from "../types.js";
import { indexExistingDeployments } from "./existing-index.js";
import { markPublishFailuresFailed, writeBulkDeployPlan } from "./persistence.js";
import { buildBulkDeployPlan } from "./plan-builder.js";
import { publishBulkDeployPlan } from "./publish.js";
import { buildResult, emptyBulkDeployResult } from "./result.js";
import { loadBulkDeployTargets, selectBulkDeployTargets } from "./targets.js";
import { traceBulkPlan, traceEmptyBulkDeploy, traceEmptyPlan, traceNoFailedRows } from "./trace.js";
import type { BulkDeployOutcome } from "./types.js";
import { resolveBulkVerifiedAccounts } from "./verified-accounts.js";

/**
 * `bulkDeployEvent` は Event / Teams を読み、選択された problems 全てに対して
 * teams × problems の deployment 行を一括 PUT し、既存 `DeployCreateRequested` を
 * 個別に publish する (= EventBridge fan-out)。
 *
 * 各 deployment 行は eventId / teamId / teamLoginKey (Team 行と同値) を持ち、
 * Phase 2c の Participant Portal は teamLoginKey で `team の全 deployment` を引ける。
 *
 * 既存 deployment と (eventId, teamId, problemId) が衝突する場合は in-memory で
 * 検出して skipped に計上する (= 後追い deploy で既行を二重生成しない)。
 *
 * `tenantId` mismatch / event 不在は `not_found`。teams / problems 両方 0 件はそのまま
 * `enqueued: 0` を返す (= operator の即時 dry-run 用途)。
 *
 * `request` (#555):
 *   - `undefined` / `{}` → 従来通り全展開 (= 既存衝突分のみ skip)
 *   - `{ retryFailedOnly: true }` → FAILED 状態の旧行を DELETE → 同 (teamId, problemId) で
 *     新 jobId の PENDING を CREATE。旧 jobId は失われる (= 履歴より状態のクリーンさを優先、
 *     failureReason の monitoring は publish 直後の CloudWatch Logs に残る)。
 *   - `{ forceRedeploy: true }` → COMPLETE / FAILED / DELETED の旧行を DELETE → 同
 *     (teamId, problemId) で新 jobId の PENDING を CREATE。PENDING / IN_PROGRESS / DELETING
 *     は二重実行防止のため skip。
 *   - `{ teamIds }` / `{ problemIds }` → 範囲を絞る (後追い team / 問題用)
 *   - 組み合わせ可能 (= `{ retryFailedOnly: true, teamIds: [t1] }` で「team t1 の失敗のみ retry」)
 */
export async function bulkDeployEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
  request?: BulkDeployRequest,
): Promise<BulkDeployOutcome> {
  const loaded = await loadBulkDeployTargets(shared, tenantId, eventId);
  if (!loaded) return { kind: "not_found" };
  if (loaded.allTeams.length === 0 || loaded.allProblems.length === 0) {
    traceEmptyBulkDeploy(eventId, tenantId, loaded, request);
    return emptyBulkDeployResult(eventId);
  }
  const selected = selectBulkDeployTargets(eventId, tenantId, loaded, request);
  if (!selected) return emptyBulkDeployResult(eventId);
  const existingDeployments = await queryDeploymentsByEvent(
    shared,
    tenantId,
    eventId,
    "jobId, teamId, problemId, #s",
  );
  const existing = indexExistingDeployments(existingDeployments);
  const retryFailedOnly = request?.retryFailedOnly === true;
  const forceRedeploy = request?.forceRedeploy === true;
  if (retryFailedOnly && existing.failedByKey.size === 0) {
    traceNoFailedRows(eventId, tenantId, existingDeployments);
    return emptyBulkDeployResult(eventId);
  }
  const verified = await resolveBulkVerifiedAccounts(
    shared,
    tenantId,
    selected.teams,
    selected.problems,
  );
  const plan = buildBulkDeployPlan({
    shared,
    tenantId,
    eventId,
    nowMs,
    event: loaded.event,
    selected,
    existing,
    verified,
    retryFailedOnly,
    forceRedeploy,
  });
  if (plan.entries.length === 0) {
    traceEmptyPlan(eventId, tenantId, selected, existing, plan, retryFailedOnly, forceRedeploy);
    return { kind: "ok", result: buildResult({ eventId, enqueued: 0, ...plan }) };
  }
  traceBulkPlan(eventId, tenantId, plan, retryFailedOnly, forceRedeploy);
  await writeBulkDeployPlan(shared, tenantId, plan.entries, retryFailedOnly || forceRedeploy);
  const failures = await publishBulkDeployPlan(
    shared,
    tenantId,
    eventId,
    plan.createdAt,
    plan.entries,
  );
  if (failures.length > 0) {
    await markPublishFailuresFailed(shared, tenantId, failures, plan.createdAt);
    throw new Error(
      `EventBridge PutEvents failed for ${failures.length} deployment(s): ${failures
        .map((f) => `${f.jobId} ${f.reason}`)
        .join("; ")}`,
    );
  }

  return {
    kind: "ok",
    result: buildResult({ eventId, enqueued: plan.entries.length, ...plan }),
  };
}
