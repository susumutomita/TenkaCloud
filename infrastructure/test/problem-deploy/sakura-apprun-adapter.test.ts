/**
 * [ADR-026 / Issues #1412, #2746] Unit tests for the sakura/apprun runtime adapter and registry.
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

describe("mapSakuraStatus (#2746)", () => {
  it("should map the current AppRun status enum", () => {
    expect(mapSakuraStatus("Healthy")).toBe("ready");
    expect(mapSakuraStatus("Deploying")).toBe("deploying");
    expect(mapSakuraStatus("UnHealthy")).toBe("failed");
  });

  it("should retain historical aliases and fail closed for unknown states", () => {
    expect(mapSakuraStatus("Running")).toBe("ready");
    expect(mapSakuraStatus("available")).toBe("ready");
    expect(mapSakuraStatus("Failed")).toBe("failed");
    expect(mapSakuraStatus("Deleting")).toBe("destroying");
    expect(mapSakuraStatus("deleted")).toBe("destroyed");
    expect(mapSakuraStatus(undefined)).toBe("destroyed");
    expect(mapSakuraStatus("totally-unknown")).toBe("deploying");
  });
});

describe("SakuraAppRunRuntimeAdapter", () => {
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

  it("should report provider and engine", () => {
    const { ctx } = makeCtx(client);
    const adapter = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect([adapter.provider, adapter.engine]).toEqual(["sakura", "apprun"]);
  });

  it("should deploy with runtime entry and platform environment after fetching the key", async () => {
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

  it("should omit the payload environment variable when no payload URL is present", async () => {
    const { ctx } = makeCtx(client);
    const { challengePayloadUrl, ...withoutPayload } = deployInput;
    await new SakuraAppRunRuntimeAdapter(ctx, runtime).deploy(withoutPayload);
    expect(client.upsertApplication.mock.calls[0][0].env).not.toHaveProperty(
      "TENKACLOUD_CHALLENGE_PAYLOAD_URL",
    );
  });

  it("should collect public_url as BaseUrl and return an empty map before it exists", async () => {
    const { ctx } = makeCtx(client);
    const adapter = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect(
      await adapter.collectOutputs({
        jobId: "j",
        namePrefix: "tc-team-a-sakura-uptime",
        region: "is1a",
        awsAccountId: "n/a",
      }),
    ).toEqual({ BaseUrl: "https://app.example" });
    client.getApplication.mockResolvedValueOnce({ status: "Deploying" });
    expect(
      await adapter.collectOutputs({
        jobId: "j",
        namePrefix: "x",
        region: "is1a",
        awsAccountId: "n/a",
      }),
    ).toEqual({});
  });

  it("should map provider status and absence through mapSakuraStatus", async () => {
    const { ctx } = makeCtx(client);
    const adapter = new SakuraAppRunRuntimeAdapter(ctx, runtime);
    expect(
      await adapter.getStatus({
        jobId: "j",
        namePrefix: "x",
        region: "is1a",
        awsAccountId: "n/a",
      }),
    ).toBe("ready");
    client.getApplication.mockResolvedValueOnce(undefined);
    expect(
      await adapter.getStatus({
        jobId: "j",
        namePrefix: "x",
        region: "is1a",
        awsAccountId: "n/a",
      }),
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

describe("selectAdapter sakura wiring", () => {
  const aws = {} as AwsCloudFormationAdapterContext;

  it("should return the Sakura adapter when account-gated dependencies are wired", () => {
    const ctx: SakuraAppRunAdapterContext = {
      getApiKey: vi.fn(),
      client: vi.fn(),
    };
    const adapter = selectAdapter(runtime, { aws, sakura: ctx });
    expect([adapter.provider, adapter.engine]).toEqual(["sakura", "apprun"]);
  });

  it("should remain reserved when Sakura dependencies are absent", () => {
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
