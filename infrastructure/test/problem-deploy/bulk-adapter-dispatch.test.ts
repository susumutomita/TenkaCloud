/**
 * [#2571] `dispatchBulkAdapterEntries` — the bulk counterpart of the
 * single-deploy adapter seam (`deploy.ts`'s `selectAdapter` +
 * `dispatchPreparedDeployment`). Dispatches every `"adapter"`-kind plan entry
 * directly (no EventBridge / CFn involved).
 *
 * `dispatchPreparedDeployment` is mocked (same seam
 * `deploy-handler-non-aws-gate.test.ts` mocks) — this suite is scoped to the
 * dispatch orchestration itself: does every entry get a `buildAdapterDependencies`
 * + `selectAdapter` + `dispatchPreparedDeployment` call with the right
 * (region="", awsAccountId="") shape, and does a rejection turn into a
 * `PublishFailure` with an "adapter dispatch failed" prefix rather than
 * propagating and losing the other entries' results.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentItem } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import type { PlanEntry } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/types";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js", () => ({
  dispatchPreparedDeployment: vi.fn(),
}));

const { dispatchPreparedDeployment } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js"
);
const { dispatchBulkAdapterEntries } = await import(
  "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/adapter-dispatch.js"
);

type AdapterPlanEntry = Extract<PlanEntry, { kind: "adapter" }>;

function adapterEntry(jobId: string): AdapterPlanEntry {
  return {
    kind: "adapter",
    item: {
      jobId,
      problemId: "gcp-problem",
      namePrefix: `tc-gcp-problem-team-${jobId}`,
      // [#2571 review-fix] A real non-AWS row always persists these as "" —
      // `dispatchOneAdapterEntry` now reads them straight off `entry.item`
      // instead of hardcoding "", so the fixture needs to actually carry them.
      region: "",
      awsAccountId: "",
    } as unknown as DeploymentItem,
    runtime: { provider: "gcp", engine: "infra-manager", entry: "template.yaml" },
    problemDir: "problems/battles/gcp-problem",
    teamSlug: `team-${jobId}`,
  };
}

function buildShared(over: Partial<EventSharedResources> = {}): EventSharedResources {
  return {
    env: "development",
    events: {} as EventSharedResources["events"],
    eventBusName: "test-bus",
    ssm: { send: vi.fn() } as unknown as EventSharedResources["ssm"],
    sakuraAppRunBaseUrl: undefined,
    ...over,
  } as unknown as EventSharedResources;
}

describe("dispatchBulkAdapterEntries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return an empty array for an empty entries list", async () => {
    const result = await dispatchBulkAdapterEntries(buildShared(), "tenant-acme", []);
    expect(result).toEqual([]);
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();
  });

  it("should dispatch every adapter entry via buildAdapterDependencies + selectAdapter + dispatchPreparedDeployment", async () => {
    vi.mocked(dispatchPreparedDeployment).mockResolvedValue(undefined);
    const entries = [adapterEntry("J1"), adapterEntry("J2")];

    const result = await dispatchBulkAdapterEntries(buildShared(), "tenant-acme", entries);

    expect(result).toEqual([]);
    expect(dispatchPreparedDeployment).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(dispatchPreparedDeployment).mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      jobId: "J1",
      tenantId: "tenant-acme",
      problemId: "gcp-problem",
      problemDir: "problems/battles/gcp-problem",
      teamSlug: "team-J1",
      namePrefix: "tc-gcp-problem-team-J1",
      region: "",
      awsAccountId: "",
    });
    expect(firstCall?.adapter).toBeDefined();
  });

  it("should source region/awsAccountId from the persisted row instead of a hardcoded literal (#2571 review-fix)", async () => {
    vi.mocked(dispatchPreparedDeployment).mockResolvedValue(undefined);
    const entry = adapterEntry("J1");
    const withNonEmptyAws = {
      ...entry,
      item: { ...entry.item, region: "ap-northeast-1", awsAccountId: "111111111111" },
    } as AdapterPlanEntry;

    await dispatchBulkAdapterEntries(buildShared(), "tenant-acme", [withNonEmptyAws]);

    const call = vi.mocked(dispatchPreparedDeployment).mock.calls[0]?.[0];
    expect(call).toMatchObject({ region: "ap-northeast-1", awsAccountId: "111111111111" });
  });

  it("should collect a PublishFailure with an 'adapter dispatch failed' prefix when dispatchPreparedDeployment rejects", async () => {
    vi.mocked(dispatchPreparedDeployment)
      .mockRejectedValueOnce(new Error("apprun REST down"))
      .mockResolvedValueOnce(undefined);
    const entries = [adapterEntry("J1"), adapterEntry("J2")];

    const result = await dispatchBulkAdapterEntries(buildShared(), "tenant-acme", entries);

    expect(result).toEqual([{ jobId: "J1", reason: "adapter dispatch failed: apprun REST down" }]);
    // The second entry's success is not swallowed by the first entry's failure.
    expect(dispatchPreparedDeployment).toHaveBeenCalledTimes(2);
  });

  it("should stringify a non-Error rejection in the PublishFailure reason", async () => {
    vi.mocked(dispatchPreparedDeployment).mockRejectedValueOnce("apprun timeout");
    const entries = [adapterEntry("J1")];

    const result = await dispatchBulkAdapterEntries(buildShared(), "tenant-acme", entries);

    expect(result).toEqual([{ jobId: "J1", reason: "adapter dispatch failed: apprun timeout" }]);
  });

  it("should collect a PublishFailure when the runtime has no adapter wiring (ssm unwired, defense-in-depth)", async () => {
    const entries = [adapterEntry("J1")];

    const result = await dispatchBulkAdapterEntries(
      buildShared({ ssm: undefined }),
      "tenant-acme",
      entries,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.jobId).toBe("J1");
    expect(result[0]?.reason).toContain("adapter dispatch failed");
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();
  });
});
