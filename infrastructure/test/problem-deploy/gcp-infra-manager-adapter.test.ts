/**
 * [ADR-027 / Issue #1411] Unit tests for the gcp/infra-manager runtime adapter + registry wiring.
 * orchestration を注入された GcpInfraManagerClient / getCredential に対して pin する
 * (実 Infra Manager REST + WIF exchange は account-gated)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsCloudFormationAdapterContext } from "../../lib/problem-deploy/handlers/shared/runtime/aws-cfn-adapter";
import {
  type GcpInfraManagerAdapterContext,
  type GcpInfraManagerClient,
  GcpInfraManagerRuntimeAdapter,
  mapGcpDeploymentState,
  type ProblemRuntime,
  RuntimeNotSupportedError,
  selectAdapter,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";

const runtime: ProblemRuntime = { provider: "gcp", engine: "infra-manager", entry: "blueprint/" };
const deployInput = {
  jobId: "job-1",
  correlationId: "job-1",
  tenantId: "t1",
  problemId: "gcp-run",
  problemDir: "problems/challenges/gcp-run",
  teamSlug: "team-a",
  namePrefix: "tc-team-a-gcp-run",
  region: "asia-northeast1",
  awsAccountId: "n/a",
};

function makeCtx(client: GcpInfraManagerClient): {
  ctx: GcpInfraManagerAdapterContext;
  getCredential: ReturnType<typeof vi.fn>;
} {
  const getCredential = vi.fn().mockResolvedValue({ accessToken: "tok" });
  return { ctx: { getCredential, client: vi.fn().mockReturnValue(client) }, getCredential };
}

describe("mapGcpDeploymentState (ADR-027 #1411)", () => {
  it("should map Infra Manager state to the 6-state runtime status", () => {
    expect(mapGcpDeploymentState("ACTIVE")).toBe("ready");
    expect(mapGcpDeploymentState("FAILED")).toBe("failed");
    expect(mapGcpDeploymentState("DELETING")).toBe("destroying");
    expect(mapGcpDeploymentState(undefined)).toBe("destroyed");
    expect(mapGcpDeploymentState("APPLYING")).toBe("deploying");
  });
});

describe("GcpInfraManagerRuntimeAdapter (ADR-027 #1411)", () => {
  let client: {
    upsertDeployment: ReturnType<typeof vi.fn>;
    getDeployment: ReturnType<typeof vi.fn>;
    deleteDeployment: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    client = {
      upsertDeployment: vi.fn().mockResolvedValue(undefined),
      getDeployment: vi
        .fn()
        .mockResolvedValue({ state: "ACTIVE", outputs: { BaseUrl: "https://run.example" } }),
      deleteDeployment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("should deploy by upserting the Infra Manager deployment with blueprintRef=entry + inputs", async () => {
    const { ctx, getCredential } = makeCtx(client);
    const result = await new GcpInfraManagerRuntimeAdapter(ctx, runtime).deploy(deployInput);
    expect(result).toEqual({ status: "deploying" });
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(client.upsertDeployment).toHaveBeenCalledWith({
      name: "tc-team-a-gcp-run",
      blueprintRef: "blueprint/",
      inputs: {
        tenkacloud_name_prefix: "tc-team-a-gcp-run",
        tenkacloud_problem_id: "gcp-run",
        tenkacloud_team: "team-a",
      },
    });
  });

  it("should collect deployment outputs / map status / destroy", async () => {
    const { ctx } = makeCtx(client);
    const a = new GcpInfraManagerRuntimeAdapter(ctx, runtime);
    const args = {
      jobId: "j",
      namePrefix: "tc-team-a-gcp-run",
      region: "asia-northeast1",
      awsAccountId: "n/a",
    };
    expect(await a.collectOutputs(args)).toEqual({ BaseUrl: "https://run.example" });
    expect(await a.getStatus(args)).toBe("ready");
    expect(await a.destroy(args)).toEqual({ status: "destroying" });
    expect(client.deleteDeployment).toHaveBeenCalledWith("tc-team-a-gcp-run");
    client.getDeployment.mockResolvedValueOnce(undefined);
    expect(await a.collectOutputs(args)).toEqual({});
  });
});

describe("selectAdapter gcp wiring (ADR-027 #1411)", () => {
  const aws = {} as AwsCloudFormationAdapterContext;
  it("should return the GCP adapter only when its WIF context is wired, else reserved", () => {
    const ctx: GcpInfraManagerAdapterContext = { getCredential: vi.fn(), client: vi.fn() };
    expect(selectAdapter(runtime, { aws, gcp: ctx }).engine).toBe("infra-manager");
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
