import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapRuntimeStatus,
  type RuntimeReconcileDeps,
  reconcileRuntimeDeployment,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/runtime-status-reconciler.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [#1410-1412] 非 AWS runtime status reconciler の振る舞い pin。 RuntimeStatus→
 * DeploymentStatus 射影 / sakura 行の getStatus→ready→COMPLETE + collectOutputs→stackOutputs /
 * 無変化 skip / AWS・runtime 欠落 skip / race(ConditionalCheckFailed) を観測する。
 */

const NOW = "2026-06-03T00:00:00.000Z";
const BASE = "https://apprun.test/api";

function deps(
  ddbSend: ReturnType<typeof vi.fn>,
  ssmSend: ReturnType<typeof vi.fn>,
): RuntimeReconcileDeps {
  return {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: ddbSend } as never,
    deploymentsTableName: "TestDeployments",
    env: "development",
    events: {} as never, // sakura adapter は aws field を使わない
    eventBusName: "bus",
    ssm: { send: ssmSend } as never,
    sakuraAppRunBaseUrl: BASE,
  };
}

const sakuraRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "META",
  jobId: "J1",
  tenantId: "t1",
  teamName: "Team A",
  namePrefix: "tc-p-team-a",
  region: "ap-northeast-1",
  awsAccountId: "999999999999",
  status: "IN_PROGRESS",
  runtimeProvider: "sakura",
  runtimeEngine: "apprun",
  runtimeEntry: "registry/img:1",
  ...over,
});

describe("runtime-status-reconciler — mapRuntimeStatus", () => {
  it("should map the 6 RuntimeStatus values to DeploymentStatus", () => {
    expect(mapRuntimeStatus("ready")).toBe("COMPLETE");
    expect(mapRuntimeStatus("failed")).toBe("FAILED");
    expect(mapRuntimeStatus("destroying")).toBe("DELETING");
    expect(mapRuntimeStatus("destroyed")).toBe("DELETED");
    expect(mapRuntimeStatus("deploying")).toBe("IN_PROGRESS");
    expect(mapRuntimeStatus("pending")).toBe("IN_PROGRESS");
  });
});

describe("runtime-status-reconciler — reconcileRuntimeDeployment", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function stubSakuraFetch(status: string, publicUrl?: string) {
    const app = {
      id: "a1",
      name: "tc-p-team-a",
      status,
      ...(publicUrl ? { public_url: publicUrl } : {}),
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/applications")) {
        return new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-a" }] }), {
          status: 200,
        });
      }
      if (path.endsWith("/applications/a1/status")) {
        return new Response(JSON.stringify({ status }), { status: 200 });
      }
      return new Response(JSON.stringify(app), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const ssmCredential = () =>
    vi.fn(async () => ({
      Parameter: { Value: JSON.stringify({ accessToken: "tok", accessTokenSecret: "sec" }) },
    }));

  it("should write COMPLETE + stackOutputs when a sakura deployment becomes ready", async () => {
    stubSakuraFetch("running", "https://app.apprun");
    const ddbSend = vi.fn().mockResolvedValue({});
    await reconcileRuntimeDeployment(deps(ddbSend, ssmCredential()), sakuraRow(), NOW);
    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.ExpressionAttributeValues?.[":next"]).toBe("COMPLETE");
    expect(cmd.input.ExpressionAttributeValues?.[":cur"]).toBe("IN_PROGRESS");
    expect(JSON.parse(cmd.input.ExpressionAttributeValues?.[":outputs"] as string)).toEqual({
      BaseUrl: "https://app.apprun",
    });
    // race ガード: 読み取り時 status と一致する条件
    expect(cmd.input.ConditionExpression).toContain("#s = :cur");
  });

  it("should NOT write when status is unchanged and not ready (deploying → IN_PROGRESS, same)", async () => {
    stubSakuraFetch("provisioning"); // → deploying → IN_PROGRESS (= current)、 ready でないので outputs 無し
    const ddbSend = vi.fn().mockResolvedValue({});
    await reconcileRuntimeDeployment(deps(ddbSend, ssmCredential()), sakuraRow(), NOW);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("should swallow ConditionalCheckFailed (concurrent teardown/tick race) without throwing", async () => {
    stubSakuraFetch("running", "https://app.apprun");
    const ddbSend = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("race"), { name: "ConditionalCheckFailedException" }),
      );
    await expect(
      reconcileRuntimeDeployment(deps(ddbSend, ssmCredential()), sakuraRow(), NOW),
    ).resolves.toBeUndefined();
  });

  it("should skip AWS / runtime-less rows without calling the cloud (no fetch, no Update)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ddbSend = vi.fn();
    const ssmSend = vi.fn();
    // runtimeProvider 無し (= legacy AWS 行)
    await reconcileRuntimeDeployment(
      deps(ddbSend, ssmSend),
      {
        ...sakuraRow(),
        runtimeProvider: undefined,
        runtimeEngine: undefined,
        runtimeEntry: undefined,
      },
      NOW,
    );
    // 明示 aws/cloudformation
    await reconcileRuntimeDeployment(
      deps(ddbSend, ssmSend),
      {
        ...sakuraRow(),
        runtimeProvider: "aws",
        runtimeEngine: "cloudformation",
        runtimeEntry: "template.yaml",
      },
      NOW,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
