/**
 * [#2571] bulk-deploy supports non-AWS single-provider (gcp/azure/sakura) problems.
 *
 * PR #2583 ("#2563 v1") added a loud refusal: a non-AWS single-provider problem
 * was counted in `unsupportedRuntimeProblems` and never published onto the
 * frozen `DeployCreateRequested` -> CFn pipeline (AWS-only). This suite covers
 * the #2571 adapter dispatch channel that replaces that refusal once
 * `shared.ssm` is wired (EventApiLambda's staged enablement): a non-AWS row
 * dispatches via `selectAdapter` + `dispatchPreparedDeployment`
 * (`adapter-dispatch.ts`) instead of riding the EventBridge fan-out / CFn
 * Distributed Map channel.
 *
 * `dispatchPreparedDeployment` is mocked (same seam
 * `deploy-handler-non-aws-gate.test.ts` mocks for the single-deploy path) —
 * exercising the real sakura/gcp/azure REST client wiring is a different
 * concern covered by each adapter's own unit tests. This suite is scoped to:
 * plan-shape (item fields), credential-existence gating (`missingCredential`),
 * and dispatch-channel routing (EventBridge vs. adapter, including the
 * Distributed Map payload and the zero-eventbridge-rows guard).
 */
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js", () => ({
  dispatchPreparedDeployment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/sakura-credential-store.js", () => ({
  getSakuraCredential: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/gcp-credential-store.js", () => ({
  getGcpCredential: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/azure-credential-store.js", () => ({
  getAzureCredential: vi.fn(),
}));

const { dispatchPreparedDeployment } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js"
);
const { getGcpCredential } = await import(
  "../../lib/problem-deploy/handlers/shared/gcp-credential-store.js"
);
const { getSakuraCredential } = await import(
  "../../lib/problem-deploy/handlers/shared/sakura-credential-store.js"
);
const { getAzureCredential } = await import(
  "../../lib/problem-deploy/handlers/shared/azure-credential-store.js"
);

const { bulkDeployEvent } = await import(
  "../../lib/problem-deploy/handlers/event-handler/bulk-deploy"
);
const { resolveBulkNonAwsCredentials } = await import(
  "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/verified-accounts.js"
);

const GCP_RUNTIME_DESCRIPTOR = (problemId: string) =>
  problemId === "hello-world"
    ? { provider: "gcp", engine: "infra-manager", entry: "template.yaml" }
    : undefined;

function buildNonAwsShared(over: Partial<EventSharedResources> = {}) {
  return buildShared({
    ssm: { send: vi.fn() } as unknown as EventSharedResources["ssm"],
    resolveProblemRuntimeDescriptor: GCP_RUNTIME_DESCRIPTOR,
    ...over,
  });
}

describe("bulkDeployEvent — non-AWS single-provider adapter dispatch (#2571)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should dispatch a non-AWS single-provider problem via adapter when ssm is wired and the team's credential is registered", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    const { shared, ddbSend, eventsSend } = buildNonAwsShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // hello-world (gcp) + hello-world-battle (aws)
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    // 1 team × 2 problems = 2 rows, both dispatch successfully (no more refusal).
    expect(out.result.enqueued).toBe(2);
    expect(out.result.unsupportedRuntime).toBeUndefined();
    expect(out.result.missingCredential).toBeUndefined();

    // The gcp row dispatched via the adapter seam, not EventBridge.
    expect(dispatchPreparedDeployment).toHaveBeenCalledOnce();
    const dispatchArgs = vi.mocked(dispatchPreparedDeployment).mock.calls[0]?.[0];
    expect(dispatchArgs).toMatchObject({
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "team-1",
      region: "",
      awsAccountId: "",
    });

    // The aws row still rides EventBridge — exactly 1 DeployCreateRequested entry.
    const putCmd = eventsSend.mock.calls
      .map((c) => c[0])
      .find((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    expect(putCmd?.input.Entries).toHaveLength(1);
    const awsDetail = JSON.parse(String(putCmd?.input.Entries?.[0]?.Detail ?? "{}"));
    expect(awsDetail.problemId).toBe("hello-world-battle");

    // Row shape: non-AWS row mirrors the single-deploy (#2561) convention.
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    const gcpItem = items.find((i) => i.Put?.Item?.problemId === "hello-world")?.Put?.Item;
    expect(gcpItem?.awsAccountId).toBe("");
    expect(gcpItem?.region).toBe("");
    expect(gcpItem).not.toHaveProperty("competitorRoleArn");
    expect(gcpItem?.runtimeProvider).toBe("gcp");
    expect(gcpItem?.runtimeEngine).toBe("infra-manager");
    expect(gcpItem?.runtimeEntry).toBe("template.yaml");
    // GSI keys / teamLoginKey / eventId / teamId stay intact (same as an AWS row).
    expect(gcpItem?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(gcpItem?.GSI2PK).toBe("TEAMKEY#key-1");
    expect(gcpItem?.teamLoginKey).toBe("key-1");
    expect(gcpItem?.eventId).toBe("EV1");
    expect(gcpItem?.teamId).toBe("T1");

    // AWS row stays byte-identical (competitorRoleArn present, non-empty account).
    const awsItem = items.find((i) => i.Put?.Item?.problemId === "hello-world-battle")?.Put?.Item;
    expect(awsItem?.awsAccountId).toBe("111111111111");
    expect(awsItem?.competitorRoleArn).toBe(
      "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(awsItem).not.toHaveProperty("runtimeProvider");
  });

  it("should report missingCredential and skip the row when the team has no registered credential for the provider", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue(undefined);
    const { shared, ddbSend, eventsSend } = buildNonAwsShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    // Only the aws row (hello-world-battle) enqueues; the gcp row is withheld.
    expect(out.result.enqueued).toBe(1);
    expect(out.result.missingCredential).toBe(1);
    expect(out.result.missingCredentials).toEqual(["gcp:team-1"]);
    expect(out.result.unsupportedRuntime).toBeUndefined();
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.Put?.Item?.problemId).toBe("hello-world-battle");
  });

  it("should not S3-put or publish EventBridge when the plan has only adapter entries (zero eventbridge rows)", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    const s3Send = vi.fn();
    const { shared, ddbSend, eventsSend } = buildNonAwsShared({
      s3: { send: s3Send } as unknown as EventSharedResources["s3"],
      bulkDeployPayloadBucket: "test-bulk-bucket",
      useBulkDistributedMap: true,
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});

    // Restrict to only the gcp problem -> zero eventbridge rows in the plan.
    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      problemIds: ["hello-world"],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(1);
    expect(dispatchPreparedDeployment).toHaveBeenCalledOnce();
    expect(s3Send).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should pack only eventbridge details into the Distributed Map S3 payload for a mixed plan", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    const s3Send = vi.fn().mockResolvedValue({});
    const { shared, ddbSend, eventsSend } = buildNonAwsShared({
      s3: { send: s3Send } as unknown as EventSharedResources["s3"],
      bulkDeployPayloadBucket: "test-bulk-bucket",
      useBulkDistributedMap: true,
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // hello-world (gcp) + hello-world-battle (aws)
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    const { PutObjectCommand: RealPutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3Calls = s3Send.mock.calls
      .map((c) => c[0])
      .filter((c): c is InstanceType<typeof RealPutObjectCommand> => c instanceof PutObjectCommand);
    expect(s3Calls).toHaveLength(1);
    const body = JSON.parse(String(s3Calls[0]?.input.Body ?? "[]"));
    // Only the aws row rides the Distributed Map payload — the gcp row dispatched
    // through the adapter seam and never becomes a DeployCreateRequestedDetail.
    expect(body).toHaveLength(1);
    expect(body[0].problemId).toBe("hello-world-battle");
    expect(dispatchPreparedDeployment).toHaveBeenCalledOnce();

    const putCmd = eventsSend.mock.calls
      .map((c) => c[0])
      .find((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    expect(putCmd?.input.Entries?.[0]?.DetailType).toBe("BulkDeployCreateRequested");
  });

  it("should mark the adapter row FAILED and throw when adapter dispatch fails", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    vi.mocked(dispatchPreparedDeployment).mockRejectedValueOnce(new Error("apprun REST down"));
    const { shared, ddbSend, eventsSend } = buildNonAwsShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const transactCmdBefore = () =>
      ddbSend.mock.calls
        .map((c) => c[0])
        .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);

    await expect(bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      /adapter dispatch failed/,
    );

    const transactCmd = transactCmdBefore();
    const gcpJobId = transactCmd?.input.TransactItems?.find(
      (i) => i.Put?.Item?.problemId === "hello-world",
    )?.Put?.Item?.jobId;
    expect(gcpJobId).toBeDefined();

    const failureUpdates = ddbSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c): c is UpdateCommand =>
          c instanceof UpdateCommand && c.input.ExpressionAttributeValues?.[":failed"] === "FAILED",
      );
    expect(failureUpdates.some((u) => u.input.Key?.PK === `DEPLOYMENT#${gcpJobId}`)).toBe(true);
  });

  it("should resolve no non-AWS credentials (and never call a credential store) when ssm is wired but every selected problem is AWS-only", async () => {
    const { shared, ddbSend, eventsSend } = buildShared({
      ssm: { send: vi.fn() } as unknown as EventSharedResources["ssm"],
      // No resolveProblemRuntimeDescriptor -> every problem falls back to aws/cloudformation.
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(2);
    expect(out.result.missingCredential).toBeUndefined();
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();
    expect(getGcpCredential).not.toHaveBeenCalled();
  });
});

describe("resolveBulkNonAwsCredentials (#2571)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return an empty set when shared.ssm is undefined", async () => {
    const shared = buildShared({ resolveProblemRuntimeDescriptor: GCP_RUNTIME_DESCRIPTOR }).shared;
    const result = await resolveBulkNonAwsCredentials(shared, "tenant-acme", sampleTeams(1), [
      { problemId: "hello-world", defaultRegion: "ap-northeast-1" },
    ]);
    expect(result).toEqual(new Set());
    expect(getGcpCredential).not.toHaveBeenCalled();
  });

  it("should return an empty set when ssm is wired but no problem resolves to a non-AWS provider", async () => {
    const shared = buildShared({
      ssm: { send: vi.fn() } as unknown as EventSharedResources["ssm"],
    }).shared;
    const result = await resolveBulkNonAwsCredentials(shared, "tenant-acme", sampleTeams(1), [
      { problemId: "hello-world-battle", defaultRegion: "us-east-1" },
    ]);
    expect(result).toEqual(new Set());
    expect(getGcpCredential).not.toHaveBeenCalled();
  });

  it("should batch-resolve sakura/azure/gcp credential existence per (provider, team)", async () => {
    vi.mocked(getSakuraCredential).mockResolvedValue({
      accessToken: "tok",
      accessTokenSecret: "sec",
    } as never);
    vi.mocked(getAzureCredential).mockResolvedValue(undefined);
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    const shared = buildShared({
      ssm: { send: vi.fn() } as unknown as EventSharedResources["ssm"],
      resolveProblemRuntimeDescriptor: (problemId) => {
        if (problemId === "sakura-problem") {
          return { provider: "sakura", engine: "apprun", entry: "registry/img:1" };
        }
        if (problemId === "azure-problem") {
          return { provider: "azure", engine: "bicep", entry: "main.bicep" };
        }
        if (problemId === "gcp-problem") {
          return { provider: "gcp", engine: "infra-manager", entry: "template.yaml" };
        }
        return undefined;
      },
    }).shared;

    const result = await resolveBulkNonAwsCredentials(shared, "tenant-acme", sampleTeams(1), [
      { problemId: "sakura-problem", defaultRegion: "ap-northeast-1" },
      { problemId: "azure-problem", defaultRegion: "ap-northeast-1" },
      { problemId: "gcp-problem", defaultRegion: "ap-northeast-1" },
    ]);

    // sakura and gcp are registered for team-1; azure is not (getAzureCredential
    // resolved undefined) — the missing pair is simply absent from the set.
    expect(result).toEqual(new Set(["sakura#team-1", "gcp#team-1"]));
    expect(getSakuraCredential).toHaveBeenCalledWith(expect.anything(), "tenant-acme", "team-1");
    expect(getAzureCredential).toHaveBeenCalledWith(expect.anything(), "tenant-acme", "team-1");
  });
});
