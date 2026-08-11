/**
 * [Issue #1268] Integration tests for runtime-aware deploy
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

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  NonAwsCredentialUnregisteredError,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  type ProblemRuntime,
  RuntimeNotSupportedError,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

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
    runtime: makeTestControlDataRuntime(),
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

describe("startDeployment with runtime-aware dispatch (Issue #1268)", () => {
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
 * [Issue #1412] sakura/apprun dispatch wiring。 SSM (per-team key store) が配線されたときだけ
 * executable になり、 AppRun REST へ deploy する (EventBridge は使わない)。 鍵未登録は loud に throw、
 * SSM 未配線では reserved のまま。 [Issue #2561] verified-AWS-account gate は provider-aware になった
 * (`resolveDeployAuthorization`) ため、 sakura/apprun は AWS competitor account 不要 — test の
 * `buildContext` が満たす verified account fixture は非 AWS runtime の deploy には使われない
 * (AWS runtime の他テストのためだけに残る共有 fixture)。
 */
describe("startDeployment sakura/apprun dispatch (Issue #1412)", () => {
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

  it("[Issue #2561] should throw loudly (no silent fallback, no cloud mutation) when no Sakura API key is registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const { ssm } = ssmReturning(undefined); // ParameterNotFound
    const { ctx, putSend } = buildContext({
      ssm: ssm as unknown as DeployContext["ssm"],
      resolveProblemRuntime: () => sakuraRuntime,
    });
    // Pre-mutation credential gate (Issue #2561) now rejects before the adapter's
    // own getApiKey closure ever runs — no DDB Put, no fetch.
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      NonAwsCredentialUnregisteredError,
    );
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
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
 * [Issue #1410 / #2743] azure/bicep dispatch wiring。 SSM (per-team Azure credential) +
 * Entra token client が配線されたときだけ executable になり、 `runtime.entry` を必ず materialize してから
 * ARM Deployment Stacks REST へ deploy する (EventBridge は使わない)。 config 未登録は loud throw、 SSM
 * 未配線では reserved のまま。 [Issue #2561] verified-AWS-account gate は provider-aware になったため、
 * azure/bicep も #1412 と同じく AWS competitor account 不要。
 *
 * [Issue #2743] Production materialization today only reads a PRIVATE (challengePayloadUrl-backed)
 * problem's artifact (`resolveAzureArtifact` in `adapter-dependencies.ts`) — reading a PUBLIC
 * problem's non-AWS target straight from a source bucket is not yet wired into this Lambda. The
 * "deploy via ARM" test below therefore configures the private-problem path (visibility + bucket +
 * S3 stub) so the deploy actually materializes `main.json` out of a real (fflate-built) payload zip
 * before it ever PUTs the Deployment Stack.
 */
describe("startDeployment azure/bicep dispatch (Issue #1410)", () => {
  const azureRuntime: ProblemRuntime = { provider: "azure", engine: "bicep", entry: "main.json" };
  const AZURE_CONFIG = {
    azureTenantId: "dir-1",
    clientId: "app-1",
    clientSecret: "shh",
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
  };
  const ARM_JSON_TEMPLATE = { $schema: "s", resources: [] };

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

  /** [Issue #2743] `main.json` inside a real (fflate) payload.zip — the private-problem source. */
  function payloadZipResponse(): Response {
    const zip = zipSync({ "main.json": strToU8(JSON.stringify(ARM_JSON_TEMPLATE)) });
    return new Response(zip, {
      status: 200,
      headers: { "content-length": String(zip.byteLength) },
    });
  }

  it("should materialize main.json from the private payload, then deploy via ARM (not EventBridge)", async () => {
    const armFetch = vi
      .fn()
      .mockResolvedValueOnce(payloadZipResponse()) // GET the challenge payload zip (materialize)
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // PUT deploymentStacks
    vi.stubGlobal("fetch", armFetch);
    const tokenClient = { getToken: vi.fn().mockResolvedValue("arm-token") };
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssmReturning(JSON.stringify(AZURE_CONFIG)) as unknown as DeployContext["ssm"],
      azureEntraTokenClient: tokenClient as unknown as DeployContext["azureEntraTokenClient"],
      resolveProblemRuntime: () => azureRuntime,
      // [Issue #2743] Private problem so `resolveChallengePayloadUrl` actually mints a URL and
      // the materializer has a real artifact source to read `main.json` from.
      problemsVisibility: { "hello-world": "private" },
      challengePayloadBucket: "test-bucket",
      s3: { send: vi.fn() } as unknown as DeployContext["s3"],
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(tokenClient.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ azureTenantId: "dir-1", clientId: "app-1", clientSecret: "shh" }),
    );
    expect(armFetch).toHaveBeenCalledTimes(2);
    // [0] = the payload zip GET (materialize), [1] = the ARM PUT with the inlined template.
    expect(armFetch.mock.calls[0][1].method).toBe("GET");
    expect(armFetch.mock.calls[1][1].method).toBe("PUT");
    const putBody = JSON.parse(armFetch.mock.calls[1][1].body);
    expect(putBody.properties.template).toEqual(ARM_JSON_TEMPLATE);
    expect(putBody.properties.templateLink).toBeUndefined();
    expect(eventsSend).not.toHaveBeenCalled();
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("[Issue #2743 / #2745] should materialize main.json from the materialized source bucket for a public problem (no private challengePayloadUrl configured)", async () => {
    // No `problemsVisibility`/`challengePayloadBucket` override → `resolveChallengePayloadUrl`
    // resolves undefined (public problem), so `resolveAzureArtifact` falls through to the
    // `sourceBucketName`/`s3` materialized-tree read instead of the private presigned-zip path.
    const armFetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })); // PUT deploymentStacks only
    vi.stubGlobal("fetch", armFetch);
    const tokenClient = { getToken: vi.fn().mockResolvedValue("arm-token") };
    const s3Send = vi.fn().mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify(ARM_JSON_TEMPLATE) },
    });
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssmReturning(JSON.stringify(AZURE_CONFIG)) as unknown as DeployContext["ssm"],
      azureEntraTokenClient: tokenClient as unknown as DeployContext["azureEntraTokenClient"],
      resolveProblemRuntime: () => azureRuntime,
      sourceBucketName: "test-source-bucket",
      s3: { send: s3Send } as unknown as DeployContext["s3"],
    });
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(s3Send).toHaveBeenCalledTimes(1);
    const getObjectCall = s3Send.mock.calls[0][0];
    expect(getObjectCall).toBeInstanceOf(GetObjectCommand);
    expect(getObjectCall.input).toEqual({
      Bucket: "test-source-bucket",
      Key: "problems/challenges/hello-world/main.json",
    });
    // No zip GET this time (public source is read straight from S3, not a presigned payload zip) —
    // the only `fetch` call is the ARM PUT itself.
    expect(armFetch).toHaveBeenCalledTimes(1);
    expect(armFetch.mock.calls[0][1].method).toBe("PUT");
    const putBody = JSON.parse(armFetch.mock.calls[0][1].body);
    expect(putBody.properties.template).toEqual(ARM_JSON_TEMPLATE);
    expect(eventsSend).not.toHaveBeenCalled();
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("[Issue #2743] should fail closed with an actionable diagnostic — before any WIF token exchange or ARM call — when neither a private challengePayloadUrl nor SOURCE_BUCKET_NAME is configured", async () => {
    const armFetch = vi.fn();
    vi.stubGlobal("fetch", armFetch);
    const tokenClient = { getToken: vi.fn().mockResolvedValue("arm-token") };
    const { ctx, putSend, eventsSend } = buildContext({
      ssm: ssmReturning(JSON.stringify(AZURE_CONFIG)) as unknown as DeployContext["ssm"],
      azureEntraTokenClient: tokenClient as unknown as DeployContext["azureEntraTokenClient"],
      resolveProblemRuntime: () => azureRuntime,
      // Neither wired: no problemsVisibility/challengePayloadBucket (public) AND no
      // sourceBucketName/s3 (no materialized-tree read either).
    });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(
      /Azure Bicep template source is unavailable/,
    );
    // The PENDING deployment row is written before the adapter is ever dispatched (unconditional
    // for every provider, Issue #2561) — this failure happens *inside* the adapter's `deploy()`, so
    // the row exists but materialize() still ran before getCredential()/upsertStack(): no WIF
    // exchange and no ARM call ever happens.
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
    expect(tokenClient.getToken).not.toHaveBeenCalled();
    expect(armFetch).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("[Issue #2561] should throw loudly when no Azure credential is registered", async () => {
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
    // Pre-mutation credential gate (Issue #2561) rejects before the token client
    // is ever touched.
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      NonAwsCredentialUnregisteredError,
    );
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
 * [Issue #1411 / #2745] gcp/infra-manager dispatch wiring。 SSM (per-team WIF config) +
 * STS client + subject-token signer が配線されたときだけ executable になり、 鍵レスで AWS subject →
 * GCP STS → SA impersonation → **Terraform blueprint materialize (#2745)** → Infra Manager REST へ
 * deploy する (EventBridge 不使用)。 config 未登録は loud throw、 SSM 未配線では reserved のまま。
 */
describe("startDeployment gcp/infra-manager dispatch (Issue #1411 / #2745)", () => {
  const gcpRuntime: ProblemRuntime = {
    provider: "gcp",
    engine: "infra-manager",
    entry: "targets/gcp",
  };
  const GCP_CONFIG = {
    wifAudience:
      "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
    serviceAccountEmail: "deployer@proj.iam.gserviceaccount.com",
    projectId: "proj-1",
    location: "asia-northeast1",
    // [Issue #2745] materializeGcpBlueprint fails closed without this.
    artifactBucket: "team-a-gcp-artifacts",
  };
  /** A real (tiny) zip so fetchChallengePayloadDirectory has a real `targets/gcp/main.tf` to find. */
  const PAYLOAD_ZIP = zipSync({ "targets/gcp/main.tf": strToU8('resource "x" {}') });

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

  it("should deploy via Infra Manager (not EventBridge) after WIF exchange + SA impersonation + blueprint materialization", async () => {
    // fetch call order: (1) materializer downloads the private payload zip, (2) materializer
    // uploads the materialized blueprint to GCS, (3) Infra Manager getRaw (GET → 404), (4) Infra
    // Manager create (POST). All four hit the SAME stubbed global fetch (no separate client).
    const gcpFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(PAYLOAD_ZIP, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ generation: "1700000000000001" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "op" }), { status: 200 }));
    vi.stubGlobal("fetch", gcpFetch);
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
      // private-problem path — the presigned URL itself is mocked at module
      // scope (`generateChallengePayloadUrl`); ctx.s3 just needs to be truthy so
      // resolveChallengePayloadUrl's "S3 client wired?" check passes.
      problemsVisibility: { "hello-world": "private" },
      challengePayloadBucket: "test-challenge-payload-bucket",
      s3: {} as unknown as DeployContext["s3"],
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
    // (1) materializer downloaded the presigned payload zip.
    expect(gcpFetch.mock.calls[0][0]).toBe("https://example.invalid/fake.zip");
    // (2) materializer uploaded the materialized blueprint to GCS with the SA token.
    expect(gcpFetch.mock.calls[1][0]).toContain(
      "https://storage.googleapis.com/upload/storage/v1/b/team-a-gcp-artifacts/o?",
    );
    expect(gcpFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer sa-token");
    // (3)-(4) Infra Manager create, with blueprintRef = the materialized gs:// ref (never the raw
    // repository-relative "targets/gcp" entry — assertGcsBlueprintRef would reject that).
    expect(gcpFetch.mock.calls[3][1].method).toBe("POST"); // Infra Manager create
    expect(gcpFetch.mock.calls[3][1].headers.Authorization).toBe("Bearer sa-token");
    const createBody = JSON.parse(gcpFetch.mock.calls[3][1].body);
    // tenant-acme / alpha-team (slugify("Alpha Team")) / hello-world — tenant/team/problem-scoped
    // content-addressed key, ending in the SA-impersonation-token-authenticated upload's generation.
    expect(createBody.terraformBlueprint.gcsSource).toMatch(
      /^gs:\/\/team-a-gcp-artifacts\/tenkacloud\/tenant-acme\/alpha-team\/hello-world\/[0-9a-f]{64}\.zip#1700000000000001$/,
    );
    expect(eventsSend).not.toHaveBeenCalled();
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("[Issue #2561] should throw loudly when no GCP credential is registered", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const signer = { sign: vi.fn() };
    const stsClient = { exchangeToken: vi.fn(), generateServiceAccountToken: vi.fn() };
    const { ctx } = buildContext({
      ssm: ssmReturning(undefined) as unknown as DeployContext["ssm"],
      gcpStsClient: stsClient as unknown as DeployContext["gcpStsClient"],
      gcpSubjectTokenSigner: signer as unknown as DeployContext["gcpSubjectTokenSigner"],
      resolveProblemRuntime: () => gcpRuntime,
    });
    // Pre-mutation credential gate (Issue #2561) rejects before the WIF signer
    // is ever touched.
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      NonAwsCredentialUnregisteredError,
    );
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
