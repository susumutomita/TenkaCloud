/**
 * [Composite Runtime / Issue #2059] Single-provider compatibility suite.
 *
 * This file is a **characterization (golden) suite** added BEFORE the Composite
 * Runtime feature (parent epic #2058). It pins the externally-observable
 * behavior of today's single-provider problems — EventBridge detail shape,
 * persisted DynamoDB item shape, teardown path, the AWS participant Console SSO
 * / CLI credential contracts, the non-AWS adapter dispatch, and catalog
 * metadata validity.
 *
 * Contract for every subsequent Composite PR (#2060 onward): this suite must
 * pass UNCHANGED. If a Composite change forces an edit here, that edit is a
 * breaking change to the single-provider contract and needs its own explicit
 * issue (per the #2058 PR gate) — it is not a free refactor.
 *
 * It deliberately asserts only observable behavior (EventBridge `Detail`, DDB
 * `Item`, HTTP-equivalent outcome objects), never private implementation
 * details, so legitimate internal refactors that preserve behavior keep it
 * green while a behavior regression turns it red.
 *
 * No production code changes accompany this file. It is tests only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import {
  type DeployContext,
  type DeployInvocation,
  type DeploySharedResources,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import type { DeploymentItem } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  getCliCredentials,
  getConsoleSigninUrl,
} from "../../lib/problem-deploy/handlers/participant-handler/sso";
import {
  type AdapterDependencies,
  AwsCloudFormationRuntimeAdapter,
  AzureBicepRuntimeAdapter,
  classifyRuntimeSupport,
  GcpInfraManagerRuntimeAdapter,
  normalizeRuntime,
  type ProblemRuntime,
  SakuraAppRunRuntimeAdapter,
  selectAdapter,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";
import {
  discoverProblemsCatalog,
  discoverProblemsRuntime,
} from "../../lib/utils/discover-problems-catalog";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/presigned-url", () => ({
  generateChallengePayloadUrl: vi.fn(async () => "https://example.invalid/fake.zip"),
}));

// getConsoleSigninUrl / getCliCredentials both new an STSClient internally; the
// participant SSO contract tests need to drive its two-stage AssumeRole without
// hitting AWS, so we replace the client with a hoisted spy (mirrors the harness
// in participant-sso.test.ts).
const { stsSend, ssmSend } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  ssmSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sts")>();
  return {
    ...actual,
    STSClient: class {
      send = stsSend;
    },
  };
});

const NOW_MS = 1_700_000_000_000;

// --------------------------------------------------------------------------
// (1) legacy runtime defaults to aws/cloudformation
// --------------------------------------------------------------------------

describe("Composite compat: legacy runtime normalization", () => {
  it("legacy runtime defaults to aws/cloudformation", () => {
    // A problem with no `runtime` and no `cfnTemplate` (= every pre-runtime
    // catalog entry) must keep resolving to the one executable combination.
    expect(normalizeRuntime({})).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
    // A legacy `cfnTemplate`-only declaration keeps its custom entry but the
    // same provider/engine.
    expect(normalizeRuntime({ cfnTemplate: "stack.yaml" })).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "stack.yaml",
    });
    expect(
      classifyRuntimeSupport({ provider: "aws", engine: "cloudformation", entry: "template.yaml" }),
    ).toBe("executable");
  });
});

// --------------------------------------------------------------------------
// Shared deploy harness for (2) and (3)
// --------------------------------------------------------------------------

function buildDeployContext(overrides: Partial<DeployContext> = {}): {
  ctx: DeployContext;
  putSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const putSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand && cmd.input.TableName === "TestCompetitorAccounts") {
      const sk = String(cmd.input.Key?.SK ?? "");
      const awsAccountId = sk.replace(/^ACCOUNT#/, "");
      return {
        Item: {
          PK: cmd.input.Key?.PK,
          SK: cmd.input.Key?.SK,
          awsAccountId,
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
        },
      };
    }
    return putSend(cmd);
  });
  const ctx: DeployContext = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    now: () => NOW_MS,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    ...overrides,
  };
  return { ctx, putSend, eventsSend };
}

const sampleDeployRequest = (overrides: Partial<DeployInvocation> = {}): DeployInvocation => ({
  problemId: "hello-world",
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  teamName: "Alpha Team",
  ...overrides,
});

describe("Composite compat: single AWS deploy event + persisted item", () => {
  beforeEach(() => vi.clearAllMocks());

  it("single AWS deploy publishes the legacy EventBridge detail exactly", async () => {
    const { ctx, eventsSend } = buildDeployContext();
    const res = await startDeployment(ctx, sampleDeployRequest());
    expect(res.status).toBe("PENDING");

    expect(eventsSend).toHaveBeenCalledOnce();
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(cmd).toBeInstanceOf(PutEventsCommand);
    const entry = cmd.input.Entries?.[0];
    expect(entry?.EventBusName).toBe("test-bus");
    expect(entry?.Source).toBe("tenkacloud.deploy");
    expect(entry?.DetailType).toBe("DeployCreateRequested");

    const detail = JSON.parse(entry?.Detail ?? "{}");
    // The State Machine input transformer keys off this exact field set. The
    // legacy detail carries NO composite-runtime markers — pin their absence so
    // a Composite PR that starts stamping provider/engine/targetId/parentJobId
    // onto the single-provider path fails here instead of silently shifting the
    // contract.
    expect(detail).not.toHaveProperty("provider");
    expect(detail).not.toHaveProperty("engine");
    expect(detail).not.toHaveProperty("targetId");
    expect(detail).not.toHaveProperty("parentJobId");
    expect(detail).not.toHaveProperty("runtimeKind");
    expect(detail).toMatchObject({
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      tenantId: "tenant-acme",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
    });
  });

  it("single AWS deployment item keeps the legacy persisted shape", async () => {
    const { ctx, putSend } = buildDeployContext();
    await startDeployment(ctx, sampleDeployRequest());

    const putCmd = putSend.mock.calls
      .map((c) => c[0])
      .find((c): c is PutCommand => c instanceof PutCommand);
    expect(putCmd).toBeInstanceOf(PutCommand);
    const item = putCmd?.input.Item as DeploymentItem;

    // Legacy key + field surface still present.
    expect(item.PK).toBe(`DEPLOYMENT#${item.jobId}`);
    expect(item.SK).toBe("META");
    expect(item.GSI1PK).toBe("TENANT#tenant-acme");
    expect(item.GSI2PK).toBe(`TEAMKEY#${item.teamLoginKey}`);
    expect(item.status).toBe("PENDING");
    expect(item.problemId).toBe("hello-world");
    expect(item.tenantId).toBe("tenant-acme");
    expect(item.region).toBe("ap-northeast-1");
    expect(item.awsAccountId).toBe("123456789012");

    // An AWS row is byte-identical to the pre-runtime shape: it carries NO
    // runtime marker fields and NO composite parent/target linkage. (#1410-1412
    // persist runtime fields only for non-AWS runtimes; Composite must not
    // start writing them onto AWS rows.)
    expect(item).not.toHaveProperty("runtimeProvider");
    expect(item).not.toHaveProperty("runtimeEngine");
    expect(item).not.toHaveProperty("runtimeEntry");
    expect(item).not.toHaveProperty("parentJobId");
    expect(item).not.toHaveProperty("targetId");
    expect(item).not.toHaveProperty("runtimeKind");
  });
});

// --------------------------------------------------------------------------
// (4) single AWS teardown keeps the legacy EventBridge delete path
// --------------------------------------------------------------------------

describe("Composite compat: single AWS teardown", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildTeardownShared(): {
    shared: DeploySharedResources;
    ddbSend: ReturnType<typeof vi.fn>;
    eventsSend: ReturnType<typeof vi.fn>;
  } {
    const ddbSend = vi.fn();
    const eventsSend = vi.fn();
    const wrappedSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand && cmd.input.TableName === "TestCompetitorAccounts") {
        const sk = String(cmd.input.Key?.SK ?? "");
        const awsAccountId = sk.replace(/^ACCOUNT#/, "");
        return {
          Item: {
            PK: cmd.input.Key?.PK,
            SK: cmd.input.Key?.SK,
            awsAccountId,
            region: "ap-northeast-1",
            competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
            verified: true,
          },
        };
      }
      return ddbSend(cmd);
    });
    const shared: DeploySharedResources = {
      runtime: makeTestControlDataRuntime(),
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: wrappedSend } as unknown as DeploySharedResources["ddb"],
      events: { send: eventsSend } as unknown as DeploySharedResources["events"],
      problemsCatalog: {},
    };
    return { shared, ddbSend, eventsSend };
  }

  // bulk-deploy / single-deploy AWS row shape: NO runtime marker fields.
  const awsRow = (over: Record<string, unknown> = {}) => ({
    PK: "DEPLOYMENT#JOB1",
    SK: "META",
    jobId: "JOB1",
    tenantId: "tenant-acme",
    problemId: "hello-world",
    awsAccountId: "999999999999",
    region: "ap-northeast-1",
    teamName: "Alpha",
    namePrefix: "tc-hello-world-alpha",
    status: "COMPLETE",
    expiresAt: 9_999_999_999,
    ...over,
  });

  it("single AWS teardown keeps the legacy EventBridge delete path", async () => {
    const { shared, ddbSend, eventsSend } = buildTeardownShared();
    const item = awsRow();
    // Guard: the row has no runtime fields, so it must NOT take the
    // adapter.destroy path (which would throw AdapterMethodNotWiredError for
    // AWS) — it must publish a CFn DeleteStack event.
    expect(item).not.toHaveProperty("runtimeProvider");
    ddbSend.mockResolvedValueOnce({ Item: item }); // Get
    ddbSend.mockResolvedValueOnce({}); // transition → DELETING
    eventsSend.mockResolvedValueOnce({}); // PutEvents

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });

    // Status flips to DELETING via a conditional UpdateCommand.
    const updateCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd?.input.ExpressionAttributeValues?.[":deleting"]).toBe("DELETING");
    expect(updateCmd?.input.ConditionExpression).toContain("tenantId = :tenantId");

    // A single DeployDeleteRequested event is published on the AWS bus.
    expect(eventsSend).toHaveBeenCalledOnce();
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd).toBeInstanceOf(PutEventsCommand);
    const entry = putCmd.input.Entries?.[0];
    expect(entry?.Source).toBe("tenkacloud.deploy");
    expect(entry?.DetailType).toBe("DeployDeleteRequested");
    const detail = JSON.parse(entry?.Detail ?? "{}");
    expect(detail).toMatchObject({
      jobId: "JOB1",
      tenantId: "tenant-acme",
      stackName: "tc-hello-world-alpha",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
    });
    expect(detail).not.toHaveProperty("targetId");
    expect(detail).not.toHaveProperty("parentJobId");
  });
});

// --------------------------------------------------------------------------
// (5) + (6) AWS participant Console SSO + CLI credentials contracts
// --------------------------------------------------------------------------

describe("Composite compat: AWS participant access contracts", () => {
  const VALID_JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
  const TEAM_KEY = "KEY1";

  function buildParticipantShared(): {
    shared: ParticipantSharedResources;
    ddbSend: ReturnType<typeof vi.fn>;
  } {
    const ddbSend = vi.fn();
    ssmSend.mockResolvedValue({ Parameter: { Value: "tenant-external-id-123456" } });
    const shared: ParticipantSharedResources = {
      runtime: makeTestControlDataRuntime(),
      tableName: "TestDeployments",
      eventsTableName: "TestEvents",
      ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
      ssm: { send: ssmSend } as unknown as ParticipantSharedResources["ssm"],
      env: "development",
      problemsScoring: {},
      problemsEndpoints: {},
    };
    return { shared, ddbSend };
  }

  const readyRow = (over: Record<string, unknown> = {}) => ({
    PK: `DEPLOYMENT#${VALID_JOB_ID}`,
    SK: "META",
    GSI2PK: `TEAMKEY#${TEAM_KEY}`,
    jobId: VALID_JOB_ID,
    problemId: "security-battle-royale",
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    namePrefix: "tc-security-battle-royale-alpha",
    tenantId: "tenant-acme",
    competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
    stackOutputs: JSON.stringify({
      ParticipantViewerRoleArn:
        "arn:aws:iam::999999999999:role/tc-security-battle-royale-alpha-participant-viewer",
    }),
    status: "COMPLETE",
    ...over,
  });

  function mockTwoStageAssumeRole(): void {
    stsSend.mockReset();
    stsSend
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "AKIADEPLOY",
          SecretAccessKey: "DEPLOYSECRET",
          SessionToken: "DEPLOYTOKEN",
          Expiration: new Date(NOW_MS),
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "AKIAVIEWER",
          SecretAccessKey: "VIEWERSECRET",
          SessionToken: "VIEWERTOKEN",
          Expiration: new Date(NOW_MS + 3_600_000),
        },
      });
  }

  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    stsSend.mockReset();
    ssmSend.mockReset();
    fetchSpy.mockReset();
  });

  afterEach(() => fetchSpy.mockReset());

  it("AWS participant console SSO contract remains unchanged", async () => {
    const { shared, ddbSend } = buildParticipantShared();

    // Non-ULID jobId is rejected up front (no DDB read).
    expect(await getConsoleSigninUrl(shared, TEAM_KEY, "not-a-ulid")).toEqual({
      kind: "invalid_jobid",
    });

    // Happy path: two-stage AssumeRole → federation getSigninToken → login URL.
    ddbSend.mockResolvedValueOnce({ Items: [readyRow()] });
    mockTwoStageAssumeRole();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ SigninToken: "SIGNIN_TOKEN_VALUE" }), { status: 200 }),
    );

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(stsSend).toHaveBeenCalledTimes(2);
    expect(stsSend.mock.calls[0]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(stsSend.mock.calls[1]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.loginUrl).toContain("https://signin.aws.amazon.com/federation");
    expect(result.loginUrl).toContain("Action=login");
    expect(result.loginUrl).toContain("SigninToken=SIGNIN_TOKEN_VALUE");
  });

  it("AWS participant CLI credentials contract remains unchanged", async () => {
    const { shared, ddbSend } = buildParticipantShared();

    // Non-ULID jobId is rejected up front.
    expect(await getCliCredentials(shared, TEAM_KEY, "not-a-ulid")).toEqual({
      kind: "invalid_jobid",
    });

    // Happy path: same two-stage AssumeRole, returns STS credentials directly
    // (no federation fetch).
    ddbSend.mockResolvedValueOnce({ Items: [readyRow()] });
    mockTwoStageAssumeRole();

    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The CLI credential view shape is the contract competitors paste into
    // `aws configure` / boto3 / Terraform — pin its exact key surface.
    expect(Object.keys(result.credentials).sort()).toEqual(
      [
        "accessKeyId",
        "awsAccountId",
        "expiration",
        "region",
        "secretAccessKey",
        "sessionToken",
      ].sort(),
    );
    expect(result.credentials.accessKeyId).toBe("AKIAVIEWER");
    expect(result.credentials.region).toBe("ap-northeast-1");
    expect(result.credentials.awsAccountId).toBe("999999999999");
    // STS credentials only — federation endpoint is never called for the CLI path.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// (7) (8) (9) Non-AWS single runtimes still dispatch through their adapter
// --------------------------------------------------------------------------

describe("Composite compat: non-AWS single runtime dispatch", () => {
  // Minimal stub contexts — selectAdapter only needs the provider context to be
  // present to dispatch; it constructs the adapter without making cloud calls.
  const sakuraCtx = {
    getApiKey: async () => ({ accessToken: "tok", accessTokenSecret: "sec" }),
    client: () => ({
      upsertApplication: async () => {},
      getApplication: async () => undefined,
      deleteApplication: async () => {},
    }),
  };
  const azureCtx = {
    getCredential: async () => ({ accessToken: "tok" }),
    client: () => ({
      upsertStack: async () => {},
      getStack: async () => undefined,
      deleteStack: async () => {},
    }),
  };
  const gcpCtx = {
    getCredential: async () => ({ accessToken: "tok" }),
    client: () => ({
      upsertDeployment: async () => {},
      getDeployment: async () => undefined,
      deleteDeployment: async () => {},
    }),
  };

  const awsDeps = {
    aws: { events: { send: vi.fn() }, eventBusName: "test-bus" },
  } as unknown as AdapterDependencies;

  it("should still dispatch a single AWS runtime through the CloudFormation adapter", () => {
    const runtime: ProblemRuntime = {
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    };
    const adapter = selectAdapter(runtime, awsDeps);
    expect(adapter).toBeInstanceOf(AwsCloudFormationRuntimeAdapter);
    expect(adapter.provider).toBe("aws");
    expect(adapter.engine).toBe("cloudformation");
  });

  it("single GCP runtime still dispatches through its adapter", () => {
    const runtime: ProblemRuntime = {
      provider: "gcp",
      engine: "infra-manager",
      entry: "gs://bucket/worker",
    };
    const deps = { ...awsDeps, gcp: gcpCtx } as unknown as AdapterDependencies;
    const adapter = selectAdapter(runtime, deps);
    expect(adapter).toBeInstanceOf(GcpInfraManagerRuntimeAdapter);
    expect(adapter.provider).toBe("gcp");
    expect(adapter.engine).toBe("infra-manager");
  });

  it("single Azure runtime still dispatches through its adapter", () => {
    const runtime: ProblemRuntime = { provider: "azure", engine: "bicep", entry: "main.bicep" };
    const deps = { ...awsDeps, azure: azureCtx } as unknown as AdapterDependencies;
    const adapter = selectAdapter(runtime, deps);
    expect(adapter).toBeInstanceOf(AzureBicepRuntimeAdapter);
    expect(adapter.provider).toBe("azure");
    expect(adapter.engine).toBe("bicep");
  });

  it("single Sakura runtime still dispatches through its adapter", () => {
    const runtime: ProblemRuntime = {
      provider: "sakura",
      engine: "apprun",
      entry: "registry/img:1",
    };
    const deps = { ...awsDeps, sakura: sakuraCtx } as unknown as AdapterDependencies;
    const adapter = selectAdapter(runtime, deps);
    expect(adapter).toBeInstanceOf(SakuraAppRunRuntimeAdapter);
    expect(adapter.provider).toBe("sakura");
    expect(adapter.engine).toBe("apprun");
  });
});

// --------------------------------------------------------------------------
// (10) all current catalog metadata remains valid
// --------------------------------------------------------------------------

describe("Composite compat: catalog metadata validity", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "compat-catalog-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function writeProblem(category: string, dir: string, body: object): void {
    const target = path.join(workspace, category, dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(body));
  }

  it("all current catalog metadata remains valid", () => {
    // Representative single-provider catalog shapes that exist today.
    writeProblem("challenges", "legacy-no-runtime", { id: "legacy-no-runtime" });
    writeProblem("challenges", "legacy-cfn-template", {
      id: "legacy-cfn-template",
      cfnTemplate: "stack.yaml",
    });
    writeProblem("battles", "explicit-aws", {
      id: "explicit-aws",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    writeProblem("challenges", "gcp-only", {
      id: "gcp-only",
      runtime: { provider: "gcp", engine: "infra-manager", entry: "gs://bucket/cfg" },
    });
    writeProblem("challenges", "azure-only", {
      id: "azure-only",
      runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
    });
    writeProblem("challenges", "sakura-only", {
      id: "sakura-only",
      runtime: { provider: "sakura", engine: "apprun", entry: "registry/img:1" },
    });
    writeProblem("challenges", "container-only", {
      id: "container-only",
      runtime: { provider: "docker", engine: "compose", entry: "local/docker-compose.yml" },
    });

    // Every catalog entry normalizes and classifies as a recognized runtime
    // (executable or reserved) — never an "unknown" typo and never undefined.
    // This is the validator-equivalent surface the Composite normalizer/
    // validator (#2060) must keep passing unchanged for single-provider
    // metadata.
    const catalog = discoverProblemsCatalog(workspace);
    expect(Object.keys(catalog).sort()).toEqual([
      "azure-only",
      "container-only",
      "explicit-aws",
      "gcp-only",
      "legacy-cfn-template",
      "legacy-no-runtime",
      "sakura-only",
    ]);

    // discoverProblemsRuntime only emits NON-aws runtimes (aws is the default
    // fallback). The three reserved providers must all survive normalization.
    const runtimes = discoverProblemsRuntime(workspace);
    expect(runtimes["gcp-only"]).toEqual({
      provider: "gcp",
      engine: "infra-manager",
      entry: "gs://bucket/cfg",
    });
    expect(runtimes["azure-only"]).toEqual({
      provider: "azure",
      engine: "bicep",
      entry: "main.bicep",
    });
    expect(runtimes["sakura-only"]).toEqual({
      provider: "sakura",
      engine: "apprun",
      entry: "registry/img:1",
    });
    // the local container runtime is recognized (classified "container",
    // not "unknown") even though it is intentionally not cloud-executable.
    expect(runtimes["container-only"]).toEqual({
      provider: "docker",
      engine: "compose",
      entry: "local/docker-compose.yml",
    });
    expect(classifyRuntimeSupport(runtimes["container-only"])).toBe("container");
    // AWS entries are intentionally omitted from the runtime map (default path).
    expect(runtimes).not.toHaveProperty("legacy-no-runtime");
    expect(runtimes).not.toHaveProperty("legacy-cfn-template");
    expect(runtimes).not.toHaveProperty("explicit-aws");

    // None of the current catalog shapes are "unknown" (= would be rejected).
    for (const runtime of Object.values(runtimes)) {
      expect(classifyRuntimeSupport(runtime)).not.toBe("unknown");
    }
  });

  it("should discover the real problems/ root without throwing (forward-compat)", () => {
    // problems/ is an external catalog (TenkaCloudChallenge) and may be empty in
    // this checkout. Whatever is present must discover cleanly — a single-
    // provider catalog must never blow up the runtime discovery used at synth.
    //
    // We do NOT assert every discovered runtime is cloud-recognized: the catalog
    // legitimately carries local-only runtimes, including the container problem from
    // Issue #2055. Those classify as "unknown" to the cloud classifier.
    // The forward-compat guarantee is only that discovery does not throw and
    // returns a plain map.
    const realRoot = path.resolve(__dirname, "../../../problems");
    expect(() => discoverProblemsRuntime(realRoot)).not.toThrow();
    expect(discoverProblemsRuntime(realRoot)).toBeTypeOf("object");
  });
});
