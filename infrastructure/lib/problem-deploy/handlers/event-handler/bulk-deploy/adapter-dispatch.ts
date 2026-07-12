import { buildAdapterDependencies } from "../../deploy-handler/adapter-dependencies.js";
import { dispatchPreparedDeployment } from "../../deploy-handler/prepared-dispatch.js";
import { selectAdapter } from "../../shared/runtime/index.js";
import type { EventSharedResources } from "../shared.js";
import type { PlanEntry, PublishFailure } from "./types.js";

type AdapterPlanEntry = Extract<PlanEntry, { kind: "adapter" }>;

/**
 * [#2571] Bulk deploy's non-AWS single-provider dispatch channel — the bulk
 * counterpart of `deploy.ts`'s single-deploy adapter seam. `dispatchBulkAdapterEntries`
 * dispatches every `"adapter"`-kind plan entry directly (no EventBridge / CFn
 * involved, mirroring `startDeployment`'s `selectAdapter` + `dispatchPreparedDeployment`
 * call): `buildAdapterDependencies` resolves the per-team credential + provider
 * client, `selectAdapter` picks the concrete runtime adapter, and
 * `dispatchPreparedDeployment` fires the initiate-only REST call — the adapter
 * returns `{status: "deploying"}` and the 1-minute reconciler tick drives the
 * row to a terminal status from there (`runtime-status-reconciler.ts`).
 *
 * All entries dispatch via `Promise.all` (independent REST calls, same
 * concurrency shape as the EventBridge fan-out publish). Every row was already
 * persisted PENDING by `writeBulkDeployPlan` before this runs (row-before-signal
 * ordering, same invariant as the EventBridge path) — a dispatch failure here
 * only needs to report back to the caller (`orchestrator.ts`) so the row can be
 * compensated to FAILED; it never leaves a half-created row.
 */
export async function dispatchBulkAdapterEntries(
  shared: EventSharedResources,
  tenantId: string,
  entries: readonly AdapterPlanEntry[],
): Promise<PublishFailure[]> {
  const results = await Promise.all(
    entries.map((entry) => dispatchOneAdapterEntry(shared, tenantId, entry)),
  );
  return results.filter((result): result is PublishFailure => result !== undefined);
}

async function dispatchOneAdapterEntry(
  shared: EventSharedResources,
  tenantId: string,
  entry: AdapterPlanEntry,
): Promise<PublishFailure | undefined> {
  try {
    const deps = buildAdapterDependencies(
      {
        env: shared.env,
        tenantId,
        events: shared.events,
        eventBusName: shared.eventBusName,
        ssm: shared.ssm,
        sakuraAppRunBaseUrl: shared.sakuraAppRunBaseUrl,
      },
      entry.runtime,
      entry.teamSlug,
    );
    const adapter = selectAdapter(entry.runtime, deps);
    await dispatchPreparedDeployment({
      adapter,
      jobId: entry.item.jobId,
      tenantId,
      problemId: entry.item.problemId,
      problemDir: entry.problemDir,
      teamSlug: entry.teamSlug,
      namePrefix: entry.item.namePrefix,
      region: "",
      awsAccountId: "",
    });
    return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { jobId: entry.item.jobId, reason: `adapter dispatch failed: ${reason}` };
  }
}
