import { logDeployTrace } from "../../shared/trace-log.js";
import { type EventSharedResources, queryDeploymentsByEvent } from "../shared.js";
import type { BulkDeployRequest } from "../types.js";
import { dispatchBulkAdapterEntries } from "./adapter-dispatch.js";
import {
  checkBulkDeployCoordinationCapacity,
  describeCapacityRefusal,
} from "./capacity-preflight.js";
import { indexExistingDeployments } from "./existing-index.js";
import { markPublishFailuresFailed, writeBulkDeployPlan } from "./persistence.js";
import { buildBulkDeployPlan } from "./plan-builder.js";
import { writePackProvenanceAudit } from "./provenance-audit.js";
import { publishBulkDeployPlan } from "./publish.js";
import { buildResult, emptyBulkDeployResult } from "./result.js";
import { loadBulkDeployTargets, selectBulkDeployTargets } from "./targets.js";
import { traceBulkPlan, traceEmptyBulkDeploy, traceEmptyPlan, traceNoFailedRows } from "./trace.js";
import type {
  AdapterPlanEntry,
  BulkDeployOutcome,
  EventBridgePlanEntry,
  PlanEntry,
} from "./types.js";
import { resolveBulkNonAwsCredentials, resolveBulkVerifiedAccounts } from "./verified-accounts.js";

/**
 * `bulkDeployEvent` は Event / Teams を読み、選択された problems 全てに対して
 * teams × problems の deployment 行を一括 PUT し、既存 `DeployCreateRequested` を
 * 個別に publish する (= EventBridge fan-out)。
 *
 * 各 deployment 行は eventId / teamId と backend-specific login index を持ち、
 * Phase 2c の Participant Portal は plaintext input から `team の全 deployment` を引ける。
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
  // [Issue #3169] Sized against the event's WHOLE roster, not `selected.teams`:
  // one coordination row holds the match for every team on that problem, so a
  // partial deploy that fits its own subset still grows the row they share.
  const capacity = checkBulkDeployCoordinationCapacity({
    problems: selected.problems,
    eventTeamCount: loaded.allTeams.length,
    problemsCoordination: shared.problemsCoordination,
    budget: shared.runtime.coordinationStateBudget(),
  });
  for (const entry of capacity.tight) {
    logDeployTrace("bulk-deploy.coordination.capacity-tight", {
      tenantId,
      eventId,
      problemIds: entry.problemId,
      teams: entry.teamCount,
      forecastBytes: entry.forecastBytes,
      maxTeams: entry.maxTeams,
      backend: entry.budget.backend,
    });
  }
  if (capacity.refusals.length > 0) {
    for (const entry of capacity.refusals) {
      logDeployTrace("bulk-deploy.coordination.capacity-exceeded", {
        tenantId,
        eventId,
        problemIds: entry.problemId,
        teams: entry.teamCount,
        forecastBytes: entry.forecastBytes,
        maxTeams: entry.maxTeams,
        backend: entry.budget.backend,
      });
    }
    // Refused before anything is persisted or published: no PENDING rows, no
    // EventBridge fan-out, nothing to unwind. Deploying anyway would put the
    // match on course to stop mid-play, which #3151 can only report once it is
    // already happening.
    return {
      kind: "capacity_exceeded",
      refusals: capacity.refusals.map(describeCapacityRefusal),
    };
  }
  const existingDeployments = await queryDeploymentsByEvent(shared, tenantId, eventId);
  const existing = indexExistingDeployments(existingDeployments);
  const retryFailedOnly = request?.retryFailedOnly === true;
  const forceRedeploy = request?.forceRedeploy === true;
  if (retryFailedOnly && existing.failedByKey.size === 0) {
    traceNoFailedRows(eventId, tenantId, existingDeployments);
    return emptyBulkDeployResult(eventId);
  }
  const [verified, nonAwsCredentials] = await Promise.all([
    resolveBulkVerifiedAccounts(shared, tenantId, selected.teams, selected.problems),
    resolveBulkNonAwsCredentials(shared, tenantId, selected.teams, selected.problems),
  ]);
  const plan = buildBulkDeployPlan({
    shared,
    tenantId,
    eventId,
    nowMs,
    event: loaded.event,
    selected,
    existing,
    verified,
    nonAwsCredentials,
    retryFailedOnly,
    forceRedeploy,
  });
  if (plan.entries.length === 0) {
    traceEmptyPlan(eventId, tenantId, selected, existing, plan, retryFailedOnly, forceRedeploy);
    return { kind: "ok", result: buildResult({ eventId, enqueued: 0, ...plan }) };
  }
  traceBulkPlan(eventId, tenantId, plan, retryFailedOnly, forceRedeploy);
  await writeBulkDeployPlan(shared, tenantId, plan.entries, retryFailedOnly || forceRedeploy);
  // [#2571] Both channels dispatch concurrently — they are independent per-row
  // operations (EventBridge fan-out / adapter REST calls) and every row was
  // already persisted PENDING above, so ordering between the two channels
  // doesn't matter.
  // [#2571 review-fix] Partition `plan.entries` exactly once here (instead of
  // `publishBulkDeployPlan` re-deriving the eventbridge subset internally via
  // its own `.filter()`) and hand each channel its own pre-filtered array.
  const { eventBridgeEntries, adapterEntries } = partitionBulkPlanEntries(plan.entries);
  const [eventBridgeFailures, adapterFailures] = await Promise.all([
    publishBulkDeployPlan(shared, tenantId, eventId, plan.createdAt, eventBridgeEntries),
    dispatchBulkAdapterEntries(shared, tenantId, adapterEntries),
  ]);
  const failures = [...eventBridgeFailures, ...adapterFailures];
  if (failures.length > 0) {
    await markPublishFailuresFailed(shared, tenantId, failures, plan.createdAt);
    throw new Error(
      `bulk deploy publish failed for ${failures.length} deployment(s): ${failures
        .map((f) => `${f.jobId} ${f.reason}`)
        .join("; ")}`,
    );
  }

  // [#2096] Append-only audit of pack-sourced deployments. Best-effort (no-op
  // when the audit table is unwired or no pack rows exist), so it never blocks
  // the deploy and core-only events behave exactly as before.
  await writePackProvenanceAudit({ tenantId, eventId, nowMs }, plan.entries);

  return {
    kind: "ok",
    result: buildResult({ eventId, enqueued: plan.entries.length, ...plan }),
  };
}

/**
 * [#2571 review-fix] Split a plan into its two dispatch channels exactly once.
 * `publish.ts`'s `publishBulkDeployPlan` used to receive the full mixed
 * `plan.entries` and re-derive the eventbridge subset with its own internal
 * `.filter()` — a second, redundant pass over the same array the caller had
 * already filtered (for `adapterEntries`) one line above. Partitioning here
 * means each channel gets exactly the pre-filtered array it needs and there is
 * only ever one filter pass over `plan.entries`.
 */
function partitionBulkPlanEntries(entries: readonly PlanEntry[]): {
  readonly eventBridgeEntries: readonly EventBridgePlanEntry[];
  readonly adapterEntries: readonly AdapterPlanEntry[];
} {
  const eventBridgeEntries: EventBridgePlanEntry[] = [];
  const adapterEntries: AdapterPlanEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "eventbridge") eventBridgeEntries.push(entry);
    else adapterEntries.push(entry);
  }
  return { eventBridgeEntries, adapterEntries };
}
