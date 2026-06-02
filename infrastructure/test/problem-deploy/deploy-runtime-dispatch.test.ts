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
