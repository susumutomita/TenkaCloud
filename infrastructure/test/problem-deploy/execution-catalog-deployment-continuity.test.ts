import {
  GetCommand,
  type PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeploySharedResources,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { retryDeployments } from "../../lib/problem-deploy/handlers/deploy-handler/retry";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { createEvent } from "../../lib/problem-deploy/handlers/event-handler/create";
import type { ResolvedExecutionCatalog } from "../../lib/problem-deploy/handlers/shared/execution-catalog";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

const readers = vi.hoisted(() => ({ current: vi.fn(), saved: vi.fn(), key: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/shared/execution-catalog", () => ({
  captureCurrentCatalog: readers.current,
  loadSavedCatalog: readers.saved,
  currentCatalogKey: readers.key,
}));

const KEY_A = `catalogs/${"a".repeat(64)}.json`;
const KEY_B = `catalogs/${"b".repeat(64)}.json`;
const PROBLEM = "hello-world";
const TENANT = "tenant-acme";
const JOB = "01J0RETRYABCDEFGHJKMNPQRST";
const DIR_A = "pack-problems/com.example.pack/1.0.0/challenges/hello-world";
const DIR_B = "pack-problems/com.example.pack/2.0.0/challenges/hello-world";
function catalog(key: string, dir: string): ResolvedExecutionCatalog {
  return {
    version: 1,
    catalogKey: key,
    catalog: { [PROBLEM]: dir },
    scoring: {},
    hints: {},
    endpoints: {},
    phases: {},
    visibility: {},
    runtimes: {},
    disruptions: {},
    writeups: {},
    coordination: {},
    plugins: {},
    sources: {},
    provenance: {
      [PROBLEM]: {
        source: "pack",
        packId: "com.example.pack",
        packVersion: key === KEY_A ? "1.0.0" : "2.0.0",
        contentDigest: key,
      },
    },
    sourceArchive: {
      bucket: "source-bucket",
      key: key === KEY_A ? "source.zip.executions/a.zip" : "source.zip.executions/b.zip",
      versionId: key === KEY_A ? "version-a" : "version-b",
    },
  };
}
const A = catalog(KEY_A, DIR_A);
const B = catalog(KEY_B, DIR_B);

beforeEach(() => {
  vi.clearAllMocks();
  readers.key.mockReturnValue(KEY_B);
  readers.current.mockResolvedValue(B);
  readers.saved.mockImplementation(async (key: string) => {
    if (key === KEY_A) return A;
    if (key === KEY_B) return B;
    throw new Error("Saved execution catalog pin is unavailable");
  });
});
afterEach(() => vi.unstubAllEnvs());

function eventFixture(key = KEY_A) {
  const fixture = buildShared({
    problemsCatalog: {}, // Current B has removed this problem entirely.
    problemsCoordination: { [PROBLEM]: { deliberately: "different current declaration" } },
    resolveProblemRuntimeDescriptor: () => ({
      provider: "docker",
      engine: "compose",
      entry: "compose.yaml",
    }),
  });
  fixture.ddbSend.mockResolvedValueOnce({
    Item: sampleEvent({
      catalogKey: key,
      problems: [{ problemId: PROBLEM, defaultRegion: "ap-northeast-1" }],
    }),
  });
  fixture.ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
  fixture.ddbSend.mockResolvedValueOnce({ Items: [] });
  fixture.ddbSend.mockResolvedValue({});
  fixture.eventsSend.mockResolvedValue({});
  return fixture;
}

function detailOf(send: ReturnType<typeof vi.fn>) {
  return JSON.parse(send.mock.calls[0]?.[0]?.input?.Entries?.[0]?.Detail ?? "{}");
}

describe("saved execution catalog deployment continuity", () => {
  it("refuses new events for problems removed from current B before persistence", async () => {
    readers.current.mockResolvedValue({ ...B, catalog: {} });
    const { shared, ddbSend } = buildShared();
    await expect(
      createEvent(
        shared,
        { tenantId: TENANT, nowMs: NOW_MS },
        {
          name: "Removed",
          teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
          problems: [{ problemId: PROBLEM, defaultRegion: "ap-northeast-1" }],
        },
      ),
    ).rejects.toThrow("unavailable in the current catalog");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("rejects a hosting-account bulk plan before event or deployment mutations", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const { shared, ddbSend, eventsSend } = eventFixture();
    await expect(bulkDeployEvent(shared, TENANT, "EV1", NOW_MS)).rejects.toMatchObject({
      code: "unsupported_hosting_account",
    });
    expect(
      ddbSend.mock.calls.some(
        ([cmd]) => cmd instanceof UpdateCommand || cmd instanceof TransactWriteCommand,
      ),
    ).toBe(false);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("pins a new event to current B, including core-only catalogs", async () => {
    readers.current.mockResolvedValue({ ...B, provenance: {} });
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValue({});
    await createEvent(
      shared,
      { tenantId: TENANT, nowMs: NOW_MS },
      {
        name: "Event B",
        teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
        problems: [{ problemId: PROBLEM, defaultRegion: "ap-northeast-1" }],
      },
    );
    const command = ddbSend.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Put?.Item?.catalogKey).toBe(KEY_B);
    expect(readers.current).toHaveBeenCalledOnce();
  });

  it("deploys saved event A after B changes/removes it without changing shared maps", async () => {
    const { shared, ddbSend, eventsSend } = eventFixture();
    const outcome = await bulkDeployEvent(shared, TENANT, "EV1", NOW_MS);
    expect(outcome.kind).toBe("ok");
    expect(detailOf(eventsSend)).toMatchObject({
      problemDir: DIR_A,
      catalogKey: KEY_A,
      sourceVersion: "version-a",
      sourceLocation: "source-bucket/source.zip.executions/a.zip",
    });
    const write = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof TransactWriteCommand) as TransactWriteCommand;
    expect(write.input.TransactItems?.[0]?.Put?.Item?.catalogKey).toBe(KEY_A);
    expect(shared.problemsCatalog).toEqual({});
    expect(shared.resolveProblemRuntimeDescriptor?.(PROBLEM)).toMatchObject({ provider: "docker" });
  });

  it("interleaves event A and B without shared catalog contamination", async () => {
    const a = eventFixture(KEY_A);
    const b = eventFixture(KEY_B);
    await Promise.all([
      bulkDeployEvent(a.shared, TENANT, "EV1", NOW_MS),
      bulkDeployEvent(b.shared, TENANT, "EV2", NOW_MS),
    ]);
    expect(detailOf(a.eventsSend).problemDir).toBe(DIR_A);
    expect(detailOf(b.eventsSend).problemDir).toBe(DIR_B);
  });

  it("refuses missing saved event artifacts before writes or enqueue", async () => {
    const { shared, ddbSend, eventsSend } = eventFixture();
    readers.saved.mockRejectedValue(new Error("catalog digest mismatch"));
    await expect(bulkDeployEvent(shared, TENANT, "EV1", NOW_MS)).rejects.toThrow(
      "catalog digest mismatch",
    );
    expect(
      ddbSend.mock.calls.some(
        ([cmd]) => cmd instanceof TransactWriteCommand || cmd instanceof UpdateCommand,
      ),
    ).toBe(false);
    expect(eventsSend).not.toHaveBeenCalled();
  });
});

function deploymentFixture(verified = true) {
  const writes = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const ddbSend = vi.fn(async (command: unknown) => {
    if (command instanceof GetCommand) {
      if (command.input.TableName === "Accounts")
        return {
          Item: { verified, competitorRoleName: "CurrentVerifiedRole", region: "ap-northeast-1" },
        };
      return {
        Item: {
          jobId: JOB,
          tenantId: TENANT,
          problemId: PROBLEM,
          catalogKey: KEY_A,
          status: "FAILED",
          awsAccountId: "111111111111",
          region: "ap-northeast-1",
          teamName: "alpha",
          namePrefix: "tc-hello-world-alpha",
          competitorRoleArn: "stale-role",
        },
      };
    }
    return writes(command);
  });
  const shared = {
    runtime: makeTestControlDataRuntime(),
    tableName: "Deployments",
    competitorAccountsTableName: "Accounts",
    env: "development",
    eventBusName: "bus",
    ddb: { send: ddbSend },
    events: { send: eventsSend },
    problemsCatalog: {},
    problemsVisibility: {},
    s3: {},
    challengePayloadBucket: undefined,
  } as unknown as DeploySharedResources;
  return { shared, writes, eventsSend };
}

function standaloneContext(shared: DeploySharedResources): DeployContext {
  return { ...shared, tenantId: TENANT, now: () => NOW_MS };
}

describe("saved job retry", () => {
  it("retries removed pack A with exact source and current authorization", async () => {
    const { shared, writes, eventsSend } = deploymentFixture();
    const result = await retryDeployments(shared, TENANT, { failedJobIds: [JOB] });
    expect(result.items[0]?.action).toBe("requeued");
    expect(writes).toHaveBeenCalledOnce();
    expect(detailOf(eventsSend)).toMatchObject({
      problemDir: DIR_A,
      catalogKey: KEY_A,
      sourceVersion: "version-a",
      sourceLocation: "source-bucket/source.zip.executions/a.zip",
      competitorRoleArn: "arn:aws:iam::111111111111:role/CurrentVerifiedRole",
      externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    });
  });

  it("keeps FAILED when saved artifacts cannot be resolved", async () => {
    const { shared, writes, eventsSend } = deploymentFixture();
    readers.saved.mockRejectedValue(new Error("catalog missing"));
    expect((await retryDeployments(shared, TENANT, { failedJobIds: [JOB] })).items[0]?.action).toBe(
      "skipped",
    );
    expect(writes).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("keeps FAILED when current account verification was revoked", async () => {
    const { shared, writes, eventsSend } = deploymentFixture(false);
    expect((await retryDeployments(shared, TENANT, { failedJobIds: [JOB] })).items[0]?.reason).toBe(
      "UnverifiedCompetitorAccountError",
    );
    expect(writes).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("captures B once for a new standalone job", async () => {
    const { shared, writes, eventsSend } = deploymentFixture();
    await startDeployment(standaloneContext(shared), {
      problemId: PROBLEM,
      teamName: "alpha",
      region: "ap-northeast-1",
      awsAccountId: "111111111111",
    });
    expect(readers.current).toHaveBeenCalledOnce();
    const row = writes.mock.calls[0]?.[0] as PutCommand;
    expect(row.input.Item?.catalogKey).toBe(KEY_B);
    expect(detailOf(eventsSend)).toMatchObject({
      problemDir: DIR_B,
      catalogKey: KEY_B,
      sourceVersion: "version-b",
      sourceLocation: "source-bucket/source.zip.executions/b.zip",
    });
  });

  it("rejects the hosting account before retry status mutation or new job writes", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const { shared, writes, eventsSend } = deploymentFixture();
    expect((await retryDeployments(shared, TENANT, { failedJobIds: [JOB] })).items[0]?.reason).toBe(
      "unsupported_hosting_account",
    );
    await expect(
      startDeployment(standaloneContext(shared), {
        problemId: PROBLEM,
        teamName: "alpha",
        region: "ap-northeast-1",
        awsAccountId: "111111111111",
      }),
    ).rejects.toMatchObject({ code: "unsupported_hosting_account" });
    expect(writes).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });
});

const NATIVE_ID = "ac26-crypto-battle";
function nativeCatalog(): ResolvedExecutionCatalog {
  return {
    ...A,
    catalog: { [NATIVE_ID]: "problems/battles/ac26-crypto-battle" },
    nativeProblems: [
      {
        kind: "coordination",
        problemId: NATIVE_ID,
        problemDir: "problems/battles/ac26-crypto-battle",
        artifactDigest: "a".repeat(64),
        pluginKey: `plugins/${"a".repeat(64)}.mjs`,
        stateBudget: { bytesPerTeam: 1, baseBytes: 0 },
        name: "Native battle",
        description: "",
        instructions: "",
      },
    ],
  };
}

describe("reviewed native Battle profile", () => {
  it("creates and deploys account-free teams with ready native rows and no provider work", async () => {
    const native = nativeCatalog();
    readers.current.mockResolvedValue(native);
    readers.saved.mockResolvedValue(native);
    const { shared, ddbSend, eventsSend } = buildShared({
      problemsCatalog: {},
      problemsProvenance: {},
    });
    ddbSend.mockResolvedValue({});
    await createEvent(
      shared,
      { tenantId: TENANT, nowMs: NOW_MS },
      {
        name: "Native",
        teams: [{ internalSlug: "alpha" }],
        problems: [{ problemId: NATIVE_ID, defaultRegion: "ap-northeast-1" }],
      },
    );
    ddbSend.mockClear();
    ddbSend.mockResolvedValueOnce({
      Item: sampleEvent({
        catalogKey: KEY_A,
        problems: [{ problemId: NATIVE_ID, defaultRegion: "ap-northeast-1" }],
      }),
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ ...sampleTeams(1)[0], awsAccountId: undefined }] });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    expect((await bulkDeployEvent(shared, TENANT, "EV1", NOW_MS)).kind).toBe("ok");
    const write = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof TransactWriteCommand) as TransactWriteCommand;
    expect(write.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      status: "COMPLETE",
      runtimeProvider: "native",
      runtimeEngine: "coordination",
      awsAccountId: "",
      region: "",
      catalogKey: KEY_A,
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("starts standalone native Battle without AWS inputs, verification or provider calls", async () => {
    readers.current.mockResolvedValue(nativeCatalog());
    const { shared, writes, eventsSend } = deploymentFixture(false);
    const result = await startDeployment(standaloneContext(shared), {
      problemId: NATIVE_ID,
      teamName: "alpha",
    });
    expect(result.status).toBe("COMPLETE");
    expect((writes.mock.calls[0][0] as PutCommand).input.Item).toMatchObject({
      awsAccountId: "",
      region: "",
      runtimeProvider: "native",
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("does not treat an arbitrary coordination declaration as account-free", async () => {
    readers.current.mockResolvedValue({
      ...A,
      coordination: { [PROBLEM]: { plugin: "not-reviewed" } },
    });
    const { shared, writes } = deploymentFixture();
    await expect(
      startDeployment(standaloneContext(shared), {
        problemId: PROBLEM,
        teamName: "alpha",
      }),
    ).rejects.toThrow("requires awsAccountId");
    expect(writes).not.toHaveBeenCalled();
  });
});
