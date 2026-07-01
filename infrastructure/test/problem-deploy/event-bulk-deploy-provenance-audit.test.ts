/**
 * [Problem Packs / Issue #2096] Audit event for pack-sourced bulk deployments.
 *
 *   - a pack deployment emits an audit event whose `extra` carries the immutable
 *     provenance (pack id / version / digest / catalogSnapshotId),
 *   - a core deployment emits no provenance audit event (existing behavior),
 *   - the audit target is the jobId (never any local path / source credential).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  DeploymentItem,
  DeploymentProvenance,
} from "../../lib/problem-deploy/handlers/deploy-handler/types";
import { writePackProvenanceAudit } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/provenance-audit";
import type { PlanEntry } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/types";

const TENANT = "tenant-acme";
const NOW_MS = 1_700_000_000_000;

const PROVENANCE: DeploymentProvenance = {
  packId: "com.example.cloud-pack",
  packVersion: "1.2.0",
  contentDigest: "sha256-abc",
  catalogSnapshotId: "snap-123",
};

const planEntry = (item: Partial<DeploymentItem>): PlanEntry =>
  ({ item: item as DeploymentItem, entry: {} }) as PlanEntry;

describe("writePackProvenanceAudit", () => {
  it("should write an audit event with provenance extra for each pack deployment", async () => {
    const write = vi.fn().mockResolvedValue(true);
    const entries = [
      planEntry({ jobId: "JOB1", problemId: "pack-problem", provenance: PROVENANCE }),
      planEntry({ jobId: "JOB2", problemId: "core-problem" }),
    ];

    await writePackProvenanceAudit(
      { tenantId: TENANT, eventId: "EV1", nowMs: NOW_MS, write },
      entries,
    );

    expect(write).toHaveBeenCalledTimes(1);
    const event = write.mock.calls[0][0];
    expect(event).toMatchObject({
      tenantId: TENANT,
      action: "deploy_pack_problem",
      outcome: "success",
      target: "JOB1",
      occurredAtMs: NOW_MS,
      extra: {
        packId: "com.example.cloud-pack",
        packVersion: "1.2.0",
        contentDigest: "sha256-abc",
        catalogSnapshotId: "snap-123",
        eventId: "EV1",
        problemId: "pack-problem",
      },
    });
  });

  it("should write no audit event when every deployment is core", async () => {
    const write = vi.fn().mockResolvedValue(true);
    await writePackProvenanceAudit({ tenantId: TENANT, eventId: "EV1", nowMs: NOW_MS, write }, [
      planEntry({ jobId: "JOB1", problemId: "core-problem" }),
    ]);
    expect(write).not.toHaveBeenCalled();
  });
});
