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

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
