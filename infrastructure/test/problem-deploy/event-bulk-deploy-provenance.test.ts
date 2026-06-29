/**
 * [Problem Packs / Issue #2096] Pack provenance threaded onto bulk-deploy rows.
 *
 * The bulk-deploy plan resolves each problem's provenance from the EVENT-pinned
 * catalog snapshot (#2095), never from client input:
 *   - a pack problem's deployment row records immutable provenance,
 *   - a core problem's row carries no provenance attribute (byte-identical),
 *   - the resolver is keyed by the server-resolved (eventId, problemId), so a
 *     caller cannot inject or override provenance.
 */

import { describe, expect, it } from "vitest";
import { buildBulkDeployPlan } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/plan-builder";
import type {
  ExistingDeploymentIndex,
  SelectedBulkDeployTargets,
} from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/types";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import type { EffectiveCatalogProvenance } from "../../lib/problem-pack/effective-catalog";

const NOW_MS = 1_700_000_000_000;
const TENANT = "tenant-acme";
const EVENT_ID = "EV1";

const PACK_PROVENANCE: EffectiveCatalogProvenance = {
  source: "pack",
  packId: "com.example.cloud-pack",
  packVersion: "1.2.0",
  contentDigest: "sha256-abc",
};

function buildShared(
  resolveDeploymentProvenance?: EventSharedResources["resolveDeploymentProvenance"],
): EventSharedResources {
  return {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    disruptionsTableName: "TestDisruptions",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: async () => ({}) } as unknown as EventSharedResources["ddb"],
    events: { send: async () => ({}) } as unknown as EventSharedResources["events"],
    s3: {} as unknown as EventSharedResources["s3"],
    scheduler: {} as unknown as EventSharedResources["scheduler"],
    problemsCatalog: {
      "pack-problem": "problems/challenges/pack-problem",
      "core-problem": "problems/challenges/core-problem",
    },
    problemsDisruptions: {},
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
    resolveDeploymentProvenance,
  };
}

const selected = (problemId: string): SelectedBulkDeployTargets => ({
  teams: [
    {
      eventId: EVENT_ID,
      teamId: "T1",
      tenantId: TENANT,
      internalSlug: "team-1",
      teamLoginKey: "key-1",
      awsAccountId: "999999999999",
    },
  ] as unknown as SelectedBulkDeployTargets["teams"],
  problems: [
    { problemId, defaultAwsAccountId: "999999999999", defaultRegion: "ap-northeast-1" },
  ] as unknown as SelectedBulkDeployTargets["problems"],
});

const emptyExisting: ExistingDeploymentIndex = {
  existingKey: new Set(),
  failedByKey: new Map(),
  forceRedeployByKey: new Map(),
};

function buildPlanFor(
  problemId: string,
  resolver?: EventSharedResources["resolveDeploymentProvenance"],
) {
  const shared = buildShared(resolver);
  return buildBulkDeployPlan({
    shared,
    tenantId: TENANT,
    eventId: EVENT_ID,
    nowMs: NOW_MS,
    event: { startsAt: undefined, endsAt: undefined },
    selected: selected(problemId),
    existing: emptyExisting,
    verified: new Map([
      [
        "999999999999",
        {
          awsAccountId: "999999999999",
          competitorRoleArn: "arn:aws:iam::999999999999:role/Role",
          externalIdParameterName: "/tenkacloud/tenant-acme/external-id",
        },
      ],
    ]),
    retryFailedOnly: false,
    forceRedeploy: false,
  });
}

describe("buildBulkDeployPlan provenance", () => {
  it("should record immutable pack provenance on a pack-sourced deployment row", () => {
    const plan = buildPlanFor("pack-problem", (eventId, problemId) =>
      eventId === EVENT_ID && problemId === "pack-problem"
        ? { provenance: PACK_PROVENANCE, catalogSnapshotId: "snap-123" }
        : undefined,
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].item.provenance).toEqual({
      packId: "com.example.cloud-pack",
      packVersion: "1.2.0",
      contentDigest: "sha256-abc",
      catalogSnapshotId: "snap-123",
    });
  });

  it("should leave a core deployment row with no provenance attribute", () => {
    const plan = buildPlanFor("core-problem", (_eventId, _problemId) => ({
      provenance: { source: "core" },
      catalogSnapshotId: "snap-123",
    }));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].item).not.toHaveProperty("provenance");
  });

  it("should keep the legacy row byte-identical when no resolver is wired", () => {
    const plan = buildPlanFor("pack-problem", undefined);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].item).not.toHaveProperty("provenance");
  });
});
