import type { AuditEvent } from "../../shared/audit-log.js";
import { writeAuditEvent } from "../../shared/audit-log.js";
import { provenanceAuditExtra } from "../../shared/deployment-provenance.js";
import type { PlanEntry } from "./types.js";

/**
 * [Problem Packs / Issue #2096] Append-only audit of PACK-SOURCED bulk
 * deployments. For every pack deployment in the plan we write one audit event
 * whose `extra` carries the immutable provenance (pack id / version / content
 * digest / catalogSnapshotId) resolved from the event-pinned snapshot (#2095) —
 * never client input. Core deployments contribute no audit event, so existing
 * behavior is unchanged. The audit row carries no local path / source credential
 * (the provenance shape is closed to id / version / digest / snapshot id).
 *
 * fail-safe: `writeAuditEvent` is best-effort (it swallows write failures and is
 * a no-op when the audit table is not wired), so a missing audit row never blocks
 * the deploy.
 */
export interface ProvenanceAuditContext {
  readonly tenantId: string;
  readonly eventId: string;
  readonly nowMs: number;
  /** Injected for tests; defaults to the shared {@link writeAuditEvent}. */
  readonly write?: (event: AuditEvent) => Promise<boolean>;
}

export async function writePackProvenanceAudit(
  ctx: ProvenanceAuditContext,
  entries: readonly PlanEntry[],
): Promise<void> {
  const write = ctx.write ?? writeAuditEvent;
  const writes: Promise<unknown>[] = [];
  for (const { item } of entries) {
    if (!item.provenance) continue;
    writes.push(
      write({
        tenantId: ctx.tenantId,
        actor: "system",
        action: "deploy_pack_problem",
        outcome: "success",
        target: item.jobId,
        occurredAtMs: ctx.nowMs,
        extra: {
          ...provenanceAuditExtra(item.provenance),
          eventId: ctx.eventId,
          problemId: item.problemId,
        },
      }),
    );
  }
  await Promise.all(writes);
}
