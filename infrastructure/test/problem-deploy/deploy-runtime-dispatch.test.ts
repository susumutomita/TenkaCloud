/**
 * [ADR-023 / Issue #1268] Integration tests for runtime-aware deploy
 * dispatch in `startDeployment`.
 *
 * What we assert:
 *   1. Legacy problems (no resolver injected) deploy on the AWS/CFn path
 *      exactly as before — same EventBridge detail shape, no extra calls.
 *   2. Explicit `runtime: aws/cloudformation` problems deploy on the same
 *      path with identical observable behavior.
 *   3. Unsupported runtimes (azure/bicep) throw `RuntimeNotSupportedError`
 *      BEFORE any DDB Put or EventBridge publish — = no cloud mutation.
 */

import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  type ProblemRuntime,
  RuntimeNotSupportedError,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/presigned-url", () => ({
  generateChallengePayloadUrl: vi.fn(async () => "https://example.invalid/fake.zip"),
}));

function buildContext(overrides: Partial<DeployContext> = {}): {
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
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    now: () => 1_700_000_000_000,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
      "azure-only-problem": "problems/challenges/azure-only-problem",
    },
    ...overrides,
  };
  return { ctx, putSend, eventsSend };
}

const sampleRequest = (overrides: Partial<DeployInvocation> = {}): DeployInvocation => ({
  problemId: "hello-world",
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  teamName: "Alpha Team",
  ...overrides,
});

describe("startDeployment with runtime-aware dispatch (ADR-023 / Issue #1268)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should deploy legacy problems exactly as before when no resolver is injected", async () => {
    const { ctx, putSend, eventsSend } = buildContext();
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    // 1 PutCommand for the deployment row
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
    // 1 PutEventsCommand for DeployCreateRequested
    expect(eventsSend).toHaveBeenCalledOnce();
    const detail = JSON.parse(eventsSend.mock.calls[0]?.[0]?.input?.Entries?.[0]?.Detail ?? "{}");
    expect(detail.problemId).toBe("hello-world");
    expect(detail.problemDir).toBe("problems/challenges/hello-world");
  });

  it("should deploy an explicit aws/cloudformation problem on the same path", async () => {
    const explicitRuntime: ProblemRuntime = {
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    };
    const { ctx, putSend, eventsSend } = buildContext({
      resolveProblemRuntime: (problemId) =>
        problemId === "hello-world" ? explicitRuntime : undefined,
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
    expect(eventsSend).toHaveBeenCalledOnce();
    const detail = JSON.parse(eventsSend.mock.calls[0]?.[0]?.input?.Entries?.[0]?.Detail ?? "{}");
    // Same shape as the legacy path — no provider/engine fields leak into the
    // detail (= byte-for-byte compat for the State Machine input transformer).
    expect(detail.problemId).toBe("hello-world");
    expect(detail.problemDir).toBe("problems/challenges/hello-world");
    expect(detail).not.toHaveProperty("provider");
    expect(detail).not.toHaveProperty("engine");
  });

  it("should throw RuntimeNotSupportedError BEFORE any DDB Put / EventBridge publish for azure/bicep", async () => {
    const azureRuntime: ProblemRuntime = {
      provider: "azure",
      engine: "bicep",
      entry: "main.bicep",
    };
    const { ctx, putSend, eventsSend } = buildContext({
      resolveProblemRuntime: (problemId) =>
        problemId === "azure-only-problem" ? azureRuntime : undefined,
    });

    await expect(
      startDeployment(ctx, sampleRequest({ problemId: "azure-only-problem" })),
    ).rejects.toBeInstanceOf(RuntimeNotSupportedError);

    // No DDB Put — the deployment row must not exist.
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
    // No EventBridge publish — the State Machine never sees this.
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should not call CompetitorAccounts lookup either when the runtime is unsupported", async () => {
    // Runtime gate happens FIRST so we save even the read-only DDB Get round-trip.
    const k8sRuntime: ProblemRuntime = {
      provider: "kubernetes",
      engine: "helm",
      entry: "Chart.yaml",
    };
    const { ctx } = buildContext({
      resolveProblemRuntime: () => k8sRuntime,
    });
    const ddbSendSpy = vi.spyOn(ctx.ddb, "send");
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      RuntimeNotSupportedError,
    );
    expect(ddbSendSpy).not.toHaveBeenCalled();
  });
});

/**
 * [ADR-026 / Issue #1412] sakura/apprun dispatch wiring。 SSM (per-team key store) が配線されたときだけ
 * executable になり、 AppRun REST へ deploy する (EventBridge は使わない)。 鍵未登録は loud に throw、
 * SSM 未配線では reserved のまま。 注: 現状の verified-AWS-account gate は provider 非依存なので test では
 * verified account を mock で満たす (= gate の provider 対応は follow-up)。
 */
describe("startDeployment sakura/apprun dispatch (ADR-026 / Issue #1412)", () => {
  const sakuraRuntime: ProblemRuntime = { provider: "sakura", engine: "apprun", entry: "img:1" };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function ssmReturning(value: string | undefined): {
    ssm: { send: ReturnType<typeof vi.fn> };
    ssmSend: ReturnType<typeof vi.fn>;
  } {
    const ssmSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetParameterCommand) {
        return value === undefined
          ? Promise.reject(Object.assign(new Error("nope"), { name: "ParameterNotFound" }))
          : { Parameter: { Value: value } };
      }
      return {};
    });
    return { ssm: { send: ssmSend }, ssmSend };
  }

  it("should deploy via AppRun (not EventBridge) and resolve the key from SSM when wired", async () => {
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "app-1" }), { status: 201 }));
    vi.stubGlobal("fetch", appRunFetch);
    const { ssm, ssmSend } = ssmReturning(
      JSON.stringify({ accessToken: "tok", accessTokenSecret: "sec" }),
    );
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssm as unknown as DeployContext["ssm"],
      resolveProblemRuntime: () => sakuraRuntime,
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    // SSM から鍵を decrypt 取得した
    expect(ssmSend.mock.calls.some((c) => c[0] instanceof GetParameterCommand)).toBe(true);
    // AppRun REST を叩いた (list → create)、 EventBridge は使わない
    expect(appRunFetch).toHaveBeenCalledTimes(2);
    expect(appRunFetch.mock.calls[1][1].method).toBe("POST");
    expect(eventsSend).not.toHaveBeenCalled();
    // deployment 行は Put 済 (= AWS と同じ enqueue セマンティクス)
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("should throw loudly (no silent fallback) when no Sakura API key is registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const { ssm } = ssmReturning(undefined); // ParameterNotFound
    const { ctx } = buildContext({
      ssm: ssm as unknown as DeployContext["ssm"],
      resolveProblemRuntime: () => sakuraRuntime,
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(/no Sakura API key/);
  });

  it("should stay reserved (RuntimeNotSupportedError) for sakura/apprun when SSM is not wired", async () => {
    const { ctx, putSend, eventsSend } = buildContext({
      // ssm omitted → deps.sakura is never built
      resolveProblemRuntime: () => sakuraRuntime,
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      RuntimeNotSupportedError,
    );
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
    expect(eventsSend).not.toHaveBeenCalled();
  });
});

/**
 * [ADR-032 / Issue #1410] azure/bicep dispatch wiring。 SSM (per-team Azure credential) + Entra token client
 * が配線されたときだけ executable になり、 ARM Deployment Stacks REST へ deploy する (EventBridge は使わない)。
 * config 未登録は loud throw、 SSM 未配線では reserved のまま。 verified-AWS-account gate は #1412 同様 follow-up。
 */
describe("startDeployment azure/bicep dispatch (ADR-032 / Issue #1410)", () => {
  const azureRuntime: ProblemRuntime = { provider: "azure", engine: "bicep", entry: "main.json" };
  const AZURE_CONFIG = {
    azureTenantId: "dir-1",
    clientId: "app-1",
    clientSecret: "shh",
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function ssmReturning(value: string | undefined): { send: ReturnType<typeof vi.fn> } {
    return {
      send: vi.fn(async (cmd: unknown) => {
        if (cmd instanceof GetParameterCommand) {
          return value === undefined
            ? Promise.reject(Object.assign(new Error("nope"), { name: "ParameterNotFound" }))
            : { Parameter: { Value: value } };
        }
        return {};
      }),
    };
  }

  it("should deploy via ARM (not EventBridge), resolving config from SSM + ARM token via the Entra client", async () => {
    const armFetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })); // PUT deploymentStacks
    vi.stubGlobal("fetch", armFetch);
    const tokenClient = { getToken: vi.fn().mockResolvedValue("arm-token") };
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssmReturning(JSON.stringify(AZURE_CONFIG)) as unknown as DeployContext["ssm"],
      azureEntraTokenClient: tokenClient as unknown as DeployContext["azureEntraTokenClient"],
      resolveProblemRuntime: () => azureRuntime,
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(tokenClient.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ azureTenantId: "dir-1", clientId: "app-1", clientSecret: "shh" }),
    );
    expect(armFetch).toHaveBeenCalledTimes(1);
    expect(armFetch.mock.calls[0][1].method).toBe("PUT");
    expect(eventsSend).not.toHaveBeenCalled();
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("should throw loudly when no Azure credential is registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const tokenClient = { getToken: vi.fn() };
    const { ctx } = buildContext({
      ssm: ssmReturning(undefined) as unknown as DeployContext["ssm"],
      azureEntraTokenClient: tokenClient as unknown as DeployContext["azureEntraTokenClient"],
      resolveProblemRuntime: () => azureRuntime,
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(/no Azure credential/);
    expect(tokenClient.getToken).not.toHaveBeenCalled();
  });

  it("should stay reserved (RuntimeNotSupportedError) for azure/bicep when SSM is not wired", async () => {
    const { ctx, putSend, eventsSend } = buildContext({
      resolveProblemRuntime: () => azureRuntime,
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      RuntimeNotSupportedError,
    );
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
    expect(eventsSend).not.toHaveBeenCalled();
  });
});

/**
 * [ADR-032 / Issue #1411] gcp/infra-manager dispatch wiring。 SSM (per-team WIF config) + STS client +
 * subject-token signer が配線されたときだけ executable になり、 鍵レスで AWS subject → GCP STS →
 * SA impersonation → Infra Manager REST へ deploy する (EventBridge 不使用)。 config 未登録は loud throw、
 * SSM 未配線では reserved のまま。
 */
describe("startDeployment gcp/infra-manager dispatch (ADR-032 / Issue #1411)", () => {
  const gcpRuntime: ProblemRuntime = {
    provider: "gcp",
    engine: "infra-manager",
    entry: "gs://b/cfg",
  };
  const GCP_CONFIG = {
    wifAudience:
      "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
    serviceAccountEmail: "deployer@proj.iam.gserviceaccount.com",
    projectId: "proj-1",
    location: "asia-northeast1",
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function ssmReturning(value: string | undefined): { send: ReturnType<typeof vi.fn> } {
    return {
      send: vi.fn(async (cmd: unknown) => {
        if (cmd instanceof GetParameterCommand) {
          return value === undefined
            ? Promise.reject(Object.assign(new Error("nope"), { name: "ParameterNotFound" }))
            : { Parameter: { Value: value } };
        }
        return {};
      }),
    };
  }

  it("should deploy via Infra Manager (not EventBridge) after WIF exchange + SA impersonation", async () => {
    // Infra Manager の getRaw (GET → 404) + create (POST) で 2 fetch。
    const imFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "op" }), { status: 200 }));
    vi.stubGlobal("fetch", imFetch);
    const signer = { sign: vi.fn().mockResolvedValue({ url: "u", method: "POST", headers: [] }) };
    const stsClient = {
      exchangeToken: vi.fn().mockResolvedValue({ access_token: "fed", expires_in: 3600 }),
      generateServiceAccountToken: vi
        .fn()
        .mockResolvedValue({ accessToken: "sa-token", expireTime: "z" }),
    };
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssmReturning(JSON.stringify(GCP_CONFIG)) as unknown as DeployContext["ssm"],
      gcpStsClient: stsClient as unknown as DeployContext["gcpStsClient"],
      gcpSubjectTokenSigner: signer as unknown as DeployContext["gcpSubjectTokenSigner"],
      awsRegion: "ap-northeast-1",
      resolveProblemRuntime: () => gcpRuntime,
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(signer.sign).toHaveBeenCalledWith({
      region: "ap-northeast-1",
      wifAudience: GCP_CONFIG.wifAudience,
    });
    expect(stsClient.exchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({ subjectTokenType: "urn:ietf:params:aws:token-type:aws4_request" }),
    );
    expect(stsClient.generateServiceAccountToken).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceAccountEmail: GCP_CONFIG.serviceAccountEmail,
        federatedToken: "fed",
      }),
    );
    expect(imFetch.mock.calls[1][1].method).toBe("POST"); // Infra Manager create
    expect(imFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer sa-token");
    expect(eventsSend).not.toHaveBeenCalled();
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("should throw loudly when no GCP credential is registered", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const signer = { sign: vi.fn() };
    const stsClient = { exchangeToken: vi.fn(), generateServiceAccountToken: vi.fn() };
    const { ctx } = buildContext({
      ssm: ssmReturning(undefined) as unknown as DeployContext["ssm"],
      gcpStsClient: stsClient as unknown as DeployContext["gcpStsClient"],
      gcpSubjectTokenSigner: signer as unknown as DeployContext["gcpSubjectTokenSigner"],
      resolveProblemRuntime: () => gcpRuntime,
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(/no GCP credential/);
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("should stay reserved (RuntimeNotSupportedError) for gcp/infra-manager when SSM is not wired", async () => {
    const { ctx, putSend, eventsSend } = buildContext({ resolveProblemRuntime: () => gcpRuntime });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      RuntimeNotSupportedError,
    );
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
    expect(eventsSend).not.toHaveBeenCalled();
  });
});
