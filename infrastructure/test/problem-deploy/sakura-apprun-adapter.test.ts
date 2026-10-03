/**
 * [Issues #1412, #2746] Unit tests for the sakura/apprun runtime adapter + its registry wiring.
 *
 * orchestration は注入された SakuraAppRunClient / getApiKey に対して全分岐を pin する
 * (= 実 AppRun REST / SSM key 取得は account-gated な別レイヤ。 #1419 executor と同方針)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsCloudFormationAdapterContext } from "../../lib/problem-deploy/handlers/shared/runtime/aws-cfn-adapter";
import {
  mapSakuraStatus,
  type ProblemRuntime,
  RuntimeNotSupportedError,
  type SakuraAppRunAdapterContext,
  type SakuraAppRunClient,
  SakuraAppRunRuntimeAdapter,
  selectAdapter,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";

const runtime: ProblemRuntime = {
  provider: "sakura",
  engine: "apprun",
  entry: "registry.example/tenkacloud/uptime-app:latest",
};

const deployInput = {
  jobId: "job-1",
  correlationId: "job-1",
  tenantId: "tenant-1",
  problemId: "sakura-uptime",
  problemDir: "problems/challenges/sakura-uptime",
  teamSlug: "team-a",
  namePrefix: "tc-team-a-sakura-uptime",
  region: "is1a",
  awsAccountId: "n/a",
  challengePayloadUrl: "https://payload.example/x",
};

function makeCtx(client: SakuraAppRunClient): {
  ctx: SakuraAppRunAdapterContext;
  getApiKey: ReturnType<typeof vi.fn>;
  clientFactory: ReturnType<typeof vi.fn>;
} {
  const getApiKey = vi.fn().mockResolvedValue({ accessToken: "AT", accessTokenSecret: "AS" });
  const clientFactory = vi.fn().mockReturnValue(client);
  return { ctx: { getApiKey, client: clientFactory }, getApiKey, clientFactory };
}

describe("mapSakuraStatus (#1412 #2746)", () => {
  it("should map current AppRun and compatible states to the 6-state runtime status", () => {
    expect(mapSakuraStatus("Healthy")).toBe("ready");
    expect(mapSakuraStatus("Running")).toBe("ready");
    expect(mapSakuraStatus("available")).toBe("ready");
    expect(mapSakuraStatus("UnHealthy")).toBe("failed");
    expect(mapSakuraStatus("Failed")).toBe("failed");
    expect(mapSakuraStatus("Deleting")).toBe("destroying");
    expect(mapSakuraStatus("deleted")).toBe("destroyed");
    expect(mapSakuraStatus(undefined)).toBe("destroyed"); // not found = 未作成/削除済
    expect(mapSakuraStatus("Deploying")).toBe("deploying");
    expect(mapSakuraStatus("Provisioning")).toBe("deploying"); // 未知/進行中は安全側
    expect(mapSakuraStatus("totally-unknown")).toBe("deploying");
  });
});

describe("SakuraAppRunRuntimeAdapter (#1412)", () => {
  let client: {
    upsertApplication: ReturnType<typeof vi.fn>;
    getApplication: ReturnType<typeof vi.fn>;
    deleteApplication: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    client = {
      upsertApplication: vi.fn().mockResolvedValue(undefined),
      getApplication: vi
        .fn()
        .mockResolvedValue({ status: "Healthy", publicUrl: "https://app.example" }),
      deleteApplication: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("should report provider/engine = sakura/apprun", () => {
    const { ctx } = makeCtx(client);
    const a = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect([a.provider, a.engine]).toEqual(["sakura", "apprun"]);
  });

  it("should deploy by upserting the AppRun app with image=entry + platform env, after fetching the key", async () => {
    const { ctx, getApiKey, clientFactory } = makeCtx(client);
    const result = await new SakuraAppRunRuntimeAdapter(ctx, runtime).deploy(deployInput);
    expect(result).toEqual({ status: "deploying" });
    expect(getApiKey).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith({ accessToken: "AT", accessTokenSecret: "AS" });
    expect(client.upsertApplication).toHaveBeenCalledWith({
      name: "tc-team-a-sakura-uptime",
      image: "registry.example/tenkacloud/uptime-app:latest",
      env: {
        TENKACLOUD_NAME_PREFIX: "tc-team-a-sakura-uptime",
        TENKACLOUD_PROBLEM_ID: "sakura-uptime",
        TENKACLOUD_TEAM: "team-a",
        TENKACLOUD_CHALLENGE_PAYLOAD_URL: "https://payload.example/x",
      },
    });
  });

  it("should omit the payload env var when no challengePayloadUrl is given", async () => {
    const { ctx } = makeCtx(client);
    const { challengePayloadUrl, ...noPayload } = deployInput;
    await new SakuraAppRunRuntimeAdapter(ctx, runtime).deploy(noPayload);
    expect(client.upsertApplication.mock.calls[0][0].env).not.toHaveProperty(
      "TENKACLOUD_CHALLENGE_PAYLOAD_URL",
    );
  });

  it("should merge bound Composite parameters into the AppRun env (#2747)", async () => {
    const { ctx } = makeCtx(client);
    await new SakuraAppRunRuntimeAdapter(ctx, runtime).deploy({
      ...deployInput,
      parameters: { TENKACLOUD_UPSTREAM_ENDPOINT: "https://aws.example" },
    });
    expect(client.upsertApplication).toHaveBeenCalledWith({
      name: "tc-team-a-sakura-uptime",
      image: "registry.example/tenkacloud/uptime-app:latest",
      env: {
        TENKACLOUD_NAME_PREFIX: "tc-team-a-sakura-uptime",
        TENKACLOUD_PROBLEM_ID: "sakura-uptime",
        TENKACLOUD_TEAM: "team-a",
        TENKACLOUD_CHALLENGE_PAYLOAD_URL: "https://payload.example/x",
        TENKACLOUD_UPSTREAM_ENDPOINT: "https://aws.example",
      },
    });
  });

  it("should collect the public URL as BaseUrl, or {} when not ready", async () => {
    const { ctx } = makeCtx(client);
    const a = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect(
      await a.collectOutputs({
        jobId: "j",
        namePrefix: "tc-team-a-sakura-uptime",
        region: "is1a",
        awsAccountId: "n/a",
      }),
    ).toEqual({
      BaseUrl: "https://app.example",
    });
    client.getApplication.mockResolvedValueOnce({ status: "Deploying" }); // no publicUrl yet
    expect(
      await a.collectOutputs({ jobId: "j", namePrefix: "x", region: "is1a", awsAccountId: "n/a" }),
    ).toEqual({});
  });

  it("should map getStatus through mapSakuraStatus", async () => {
    const { ctx } = makeCtx(client);
    const a = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect(
      await a.getStatus({ jobId: "j", namePrefix: "x", region: "is1a", awsAccountId: "n/a" }),
    ).toBe("ready");
    client.getApplication.mockResolvedValueOnce(undefined);
    expect(
      await a.getStatus({ jobId: "j", namePrefix: "x", region: "is1a", awsAccountId: "n/a" }),
    ).toBe("destroyed");
  });

  it("should destroy by deleting the AppRun application", async () => {
    const { ctx } = makeCtx(client);
    const result = await new SakuraAppRunRuntimeAdapter(ctx, runtime).destroy({
      jobId: "j",
      namePrefix: "tc-team-a-sakura-uptime",
      region: "is1a",
      awsAccountId: "n/a",
    });
    expect(result).toEqual({ status: "destroying" });
    expect(client.deleteApplication).toHaveBeenCalledWith("tc-team-a-sakura-uptime");
  });
});

describe("selectAdapter sakura wiring (#1412)", () => {
  const aws = {} as AwsCloudFormationAdapterContext;

  it("should return the Sakura adapter when the account-gated context is wired", () => {
    const ctx: SakuraAppRunAdapterContext = {
      getApiKey: vi.fn(),
      client: vi.fn(),
    };
    const a = selectAdapter(runtime, { aws, sakura: ctx });
    expect([a.provider, a.engine]).toEqual(["sakura", "apprun"]);
  });

  it("should stay reserved (RuntimeNotSupportedError) when sakura deps are absent", () => {
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
