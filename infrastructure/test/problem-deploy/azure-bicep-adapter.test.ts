/**
 * [Issue #1410 / #2743] Unit tests for the azure/bicep runtime adapter + registry wiring.
 * orchestration を注入された AzureDeploymentStackClient / getCredential / materialize に対して pin する
 * (実 ARM REST + WIF exchange + Bicep compile は account-gated / #2743 別レイヤ)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsCloudFormationAdapterContext } from "../../lib/problem-deploy/handlers/shared/runtime/aws-cfn-adapter";
import {
  type AzureBicepAdapterContext,
  AzureBicepRuntimeAdapter,
  type AzureDeploymentStackClient,
  mapAzureProvisioningState,
  type ProblemRuntime,
  RuntimeNotSupportedError,
  selectAdapter,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";
import type { InlineArmTemplate } from "../../lib/problem-deploy/runtime-clients/azure-template-materializer";

const runtime: ProblemRuntime = { provider: "azure", engine: "bicep", entry: "main.bicep" };
const deployInput = {
  jobId: "job-1",
  correlationId: "job-1",
  tenantId: "t1",
  problemId: "azure-fn",
  problemDir: "problems/challenges/azure-fn",
  teamSlug: "team-a",
  namePrefix: "tc-team-a-azure-fn",
  region: "japaneast",
  awsAccountId: "n/a",
};

const ARM_DOCUMENT = { $schema: "s", resources: [] };
const MATERIALIZED: InlineArmTemplate = {
  document: ARM_DOCUMENT,
  sourceSha256: "deadbeef",
  diagnostics: [],
};

function makeCtx(client: AzureDeploymentStackClient): {
  ctx: AzureBicepAdapterContext;
  getCredential: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
} {
  const getCredential = vi.fn().mockResolvedValue({ accessToken: "tok" });
  const factory = vi.fn().mockReturnValue(client);
  const materialize = vi.fn().mockResolvedValue(MATERIALIZED);
  return {
    ctx: { getCredential, client: factory, materialize },
    getCredential,
    factory,
    materialize,
  };
}

describe("mapAzureProvisioningState (#1410)", () => {
  it("should map ARM provisioningState to the 6-state runtime status", () => {
    expect(mapAzureProvisioningState("Succeeded")).toBe("ready");
    expect(mapAzureProvisioningState("Failed")).toBe("failed");
    expect(mapAzureProvisioningState("Canceled")).toBe("failed");
    expect(mapAzureProvisioningState("Deleting")).toBe("destroying");
    expect(mapAzureProvisioningState("Deleted")).toBe("destroyed");
    expect(mapAzureProvisioningState(undefined)).toBe("destroyed");
    expect(mapAzureProvisioningState("Running")).toBe("deploying");
  });
});

describe("AzureBicepRuntimeAdapter (#1410 / #2743)", () => {
  let client: {
    upsertStack: ReturnType<typeof vi.fn>;
    getStack: ReturnType<typeof vi.fn>;
    deleteStack: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    client = {
      upsertStack: vi.fn().mockResolvedValue(undefined),
      getStack: vi.fn().mockResolvedValue({
        provisioningState: "Succeeded",
        outputs: { BaseUrl: "https://fn.example" },
      }),
      deleteStack: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("should materialize entry BEFORE upserting the Deployment Stack with the inline template + params", async () => {
    const { ctx, getCredential, materialize } = makeCtx(client);
    const result = await new AzureBicepRuntimeAdapter(ctx, runtime).deploy(deployInput);
    expect(result).toEqual({ status: "deploying" });
    expect(materialize).toHaveBeenCalledWith("main.bicep", {
      problemDir: "problems/challenges/azure-fn",
    });
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(client.upsertStack).toHaveBeenCalledWith({
      name: "tc-team-a-azure-fn",
      template: { kind: "inline", document: ARM_DOCUMENT },
      parameters: {
        tenkacloudNamePrefix: "tc-team-a-azure-fn",
        tenkacloudProblemId: "azure-fn",
        tenkacloudTeam: "team-a",
      },
    });
  });

  it("should pass challengePayloadUrl through to materialize's artifact location", async () => {
    const { ctx, materialize } = makeCtx(client);
    await new AzureBicepRuntimeAdapter(ctx, runtime).deploy({
      ...deployInput,
      challengePayloadUrl: "https://s3.example/presigned",
    });
    expect(materialize).toHaveBeenCalledWith("main.bicep", {
      problemDir: "problems/challenges/azure-fn",
      challengePayloadUrl: "https://s3.example/presigned",
    });
  });

  it("should merge bound Composite parameters into the Deployment Stack params (#2747)", async () => {
    const { ctx } = makeCtx(client);
    await new AzureBicepRuntimeAdapter(ctx, runtime).deploy({
      ...deployInput,
      parameters: { tenkacloudUpstreamEndpoint: "https://aws.example" },
    });
    expect(client.upsertStack).toHaveBeenCalledWith({
      name: "tc-team-a-azure-fn",
      template: { kind: "inline", document: ARM_DOCUMENT },
      parameters: {
        tenkacloudNamePrefix: "tc-team-a-azure-fn",
        tenkacloudProblemId: "azure-fn",
        tenkacloudTeam: "team-a",
        tenkacloudUpstreamEndpoint: "https://aws.example",
      },
    });
  });

  it("should include non-empty compiler diagnostics in the materialize trace log (#2743)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { ctx } = makeCtx(client);
      ctx.materialize = vi.fn().mockResolvedValue({
        document: ARM_DOCUMENT,
        sourceSha256: "deadbeef",
        diagnostics: ["Warning BCP035: unused param 'foo'"],
      });
      await new AzureBicepRuntimeAdapter(ctx, runtime).deploy(deployInput);
      const traceCall = logSpy.mock.calls.find(([line]) =>
        String(line).includes("deploy.azure-bicep.materialize"),
      );
      expect(traceCall).toBeDefined();
      const traceBody = JSON.parse(String(traceCall?.[0]));
      expect(traceBody.diagnostics).toEqual(["Warning BCP035: unused param 'foo'"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("should propagate a materialize failure WITHOUT touching credentials or the Azure client (#2743)", async () => {
    const { ctx, getCredential, factory } = makeCtx(client);
    ctx.materialize = vi.fn().mockRejectedValue(new Error("no Bicep compiler is configured"));
    await expect(new AzureBicepRuntimeAdapter(ctx, runtime).deploy(deployInput)).rejects.toThrow(
      /no Bicep compiler is configured/,
    );
    expect(getCredential).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(client.upsertStack).not.toHaveBeenCalled();
  });

  it("should collect stack outputs / map status / destroy", async () => {
    const { ctx } = makeCtx(client);
    const a = new AzureBicepRuntimeAdapter(ctx, runtime);
    const args = {
      jobId: "j",
      namePrefix: "tc-team-a-azure-fn",
      region: "japaneast",
      awsAccountId: "n/a",
    };
    expect(await a.collectOutputs(args)).toEqual({ BaseUrl: "https://fn.example" });
    expect(await a.getStatus(args)).toBe("ready");
    expect(await a.destroy(args)).toEqual({ status: "destroying" });
    expect(client.deleteStack).toHaveBeenCalledWith("tc-team-a-azure-fn");
    client.getStack.mockResolvedValueOnce(undefined);
    expect(await a.collectOutputs(args)).toEqual({});
  });
});

describe("selectAdapter azure wiring (#1410)", () => {
  const aws = {} as AwsCloudFormationAdapterContext;
  it("should return the Azure adapter only when its WIF context is wired, else reserved", () => {
    const ctx: AzureBicepAdapterContext = {
      getCredential: vi.fn(),
      client: vi.fn(),
      materialize: vi.fn(),
    };
    expect(selectAdapter(runtime, { aws, azure: ctx }).provider).toBe("azure");
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
