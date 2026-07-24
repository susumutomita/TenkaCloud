/**
 * [ADR-027 / Issue #1410] Unit tests for the azure/bicep runtime adapter + registry wiring.
 * orchestration を注入された AzureDeploymentStackClient / getCredential に対して pin する
 * (実 ARM REST + WIF exchange は account-gated)。
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

function makeCtx(client: AzureDeploymentStackClient): {
  ctx: AzureBicepAdapterContext;
  getCredential: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
} {
  const getCredential = vi.fn().mockResolvedValue({ accessToken: "tok" });
  const factory = vi.fn().mockReturnValue(client);
  return { ctx: { getCredential, client: factory }, getCredential, factory };
}

describe("mapAzureProvisioningState (ADR-027 #1410)", () => {
  it("should map ARM provisioningState to the 6-state runtime status", () => {
    expect(mapAzureProvisioningState("Succeeded")).toBe("ready");
    expect(mapAzureProvisioningState("Failed")).toBe("failed");
    expect(mapAzureProvisioningState("Canceled")).toBe("failed");
    expect(mapAzureProvisioningState("Deleting")).toBe("destroying");
    expect(mapAzureProvisioningState(undefined)).toBe("destroyed");
    expect(mapAzureProvisioningState("Running")).toBe("deploying");
  });
});

describe("AzureBicepRuntimeAdapter (ADR-027 #1410)", () => {
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

  it("should deploy by upserting the Deployment Stack with templateRef=entry + params", async () => {
    const { ctx, getCredential } = makeCtx(client);
    const result = await new AzureBicepRuntimeAdapter(ctx, runtime).deploy(deployInput);
    expect(result).toEqual({ status: "deploying" });
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(client.upsertStack).toHaveBeenCalledWith({
      name: "tc-team-a-azure-fn",
      templateRef: "main.bicep",
      parameters: {
        tenkacloudNamePrefix: "tc-team-a-azure-fn",
        tenkacloudProblemId: "azure-fn",
        tenkacloudTeam: "team-a",
      },
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
      templateRef: "main.bicep",
      parameters: {
        tenkacloudNamePrefix: "tc-team-a-azure-fn",
        tenkacloudProblemId: "azure-fn",
        tenkacloudTeam: "team-a",
        tenkacloudUpstreamEndpoint: "https://aws.example",
      },
    });
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

describe("selectAdapter azure wiring (ADR-027 #1410)", () => {
  const aws = {} as AwsCloudFormationAdapterContext;
  it("should return the Azure adapter only when its WIF context is wired, else reserved", () => {
    const ctx: AzureBicepAdapterContext = { getCredential: vi.fn(), client: vi.fn() };
    expect(selectAdapter(runtime, { aws, azure: ctx }).provider).toBe("azure");
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
