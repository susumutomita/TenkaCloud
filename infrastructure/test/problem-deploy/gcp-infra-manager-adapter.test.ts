/**
 * [Issue #1411 / #2745] Unit tests for the gcp/infra-manager runtime adapter + registry
 * wiring. orchestration を注入された GcpInfraManagerClient / getCredential / materializeBlueprint に
 * 対して pin する (= 実 Infra Manager REST + WIF exchange + 実 materializer は account-gated / 別レイヤ)。
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

const runtime: ProblemRuntime = { provider: "gcp", engine: "infra-manager", entry: "targets/gcp" };
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

/** [#2745] The fake materializer's fixed output — distinct from `runtime.entry` on purpose, so an
 * assertion on `blueprintRef` proves the adapter used the MATERIALIZED ref, not the raw entry. */
const MATERIALIZED_REF = "gs://team-a-artifacts/tenkacloud/t1/team-a/gcp-run/deadbeef.zip#1";

function makeCtx(client: GcpInfraManagerClient): {
  ctx: GcpInfraManagerAdapterContext;
  getCredential: ReturnType<typeof vi.fn>;
  materializeBlueprint: ReturnType<typeof vi.fn>;
} {
  const getCredential = vi.fn().mockResolvedValue({ accessToken: "tok" });
  const materializeBlueprint = vi.fn().mockResolvedValue(MATERIALIZED_REF);
  return {
    ctx: { getCredential, client: vi.fn().mockReturnValue(client), materializeBlueprint },
    getCredential,
    materializeBlueprint,
  };
}

describe("mapGcpDeploymentState (#1411)", () => {
  it("should map Infra Manager state to the 6-state runtime status", () => {
    expect(mapGcpDeploymentState("ACTIVE")).toBe("ready");
    expect(mapGcpDeploymentState("FAILED")).toBe("failed");
    expect(mapGcpDeploymentState("DELETING")).toBe("destroying");
    expect(mapGcpDeploymentState(undefined)).toBe("destroyed");
    expect(mapGcpDeploymentState("APPLYING")).toBe("deploying");
  });
});

describe("GcpInfraManagerRuntimeAdapter (#1411)", () => {
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

  it("should deploy by materializing the blueprint THEN upserting with blueprintRef=materialized ref (#2745)", async () => {
    const { ctx, getCredential, materializeBlueprint } = makeCtx(client);
    const result = await new GcpInfraManagerRuntimeAdapter(ctx, runtime).deploy(deployInput);
    expect(result).toEqual({ status: "deploying" });
    // getCredential runs once and is reused for BOTH materializeBlueprint and client() — no
    // second WIF exchange per deploy.
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(materializeBlueprint).toHaveBeenCalledWith(
      { accessToken: "tok" },
      {
        tenantId: "t1",
        teamSlug: "team-a",
        problemId: "gcp-run",
        problemDir: "problems/challenges/gcp-run",
        entry: "targets/gcp", // runtime.entry, NOT yet a gs:// ref
      },
    );
    expect(client.upsertDeployment).toHaveBeenCalledWith({
      name: "tc-team-a-gcp-run",
      blueprintRef: MATERIALIZED_REF, // materialized gs:// ref, not the raw repository entry
      inputs: {
        tenkacloud_name_prefix: "tc-team-a-gcp-run",
        tenkacloud_problem_id: "gcp-run",
        tenkacloud_team: "team-a",
      },
    });
  });

  it("should pass challengePayloadUrl through to materializeBlueprint for a private problem", async () => {
    const { ctx, materializeBlueprint } = makeCtx(client);
    await new GcpInfraManagerRuntimeAdapter(ctx, runtime).deploy({
      ...deployInput,
      challengePayloadUrl: "https://s3.example/presigned",
    });
    expect(materializeBlueprint).toHaveBeenCalledWith(
      { accessToken: "tok" },
      expect.objectContaining({ challengePayloadUrl: "https://s3.example/presigned" }),
    );
  });

  it("should propagate a materializer failure WITHOUT calling the provider client (fail-closed, no provider mutation)", async () => {
    const { ctx, materializeBlueprint } = makeCtx(client);
    materializeBlueprint.mockRejectedValueOnce(new Error("no artifactBucket registered"));

    await expect(
      new GcpInfraManagerRuntimeAdapter(ctx, runtime).deploy(deployInput),
    ).rejects.toThrow(/no artifactBucket registered/);
    expect(client.upsertDeployment).not.toHaveBeenCalled();
  });

  it("should merge bound Composite parameters into Infra Manager inputs (#2747)", async () => {
    const { ctx } = makeCtx(client);
    await new GcpInfraManagerRuntimeAdapter(ctx, runtime).deploy({
      ...deployInput,
      parameters: { tenkacloud_upstream_endpoint: "https://aws.example" },
    });
    expect(client.upsertDeployment).toHaveBeenCalledWith({
      name: "tc-team-a-gcp-run",
      blueprintRef: MATERIALIZED_REF,
      inputs: {
        tenkacloud_name_prefix: "tc-team-a-gcp-run",
        tenkacloud_problem_id: "gcp-run",
        tenkacloud_team: "team-a",
        tenkacloud_upstream_endpoint: "https://aws.example",
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

describe("selectAdapter gcp wiring (#1411)", () => {
  const aws = {} as AwsCloudFormationAdapterContext;
  it("should return the GCP adapter only when its WIF context is wired, else reserved", () => {
    const ctx: GcpInfraManagerAdapterContext = {
      getCredential: vi.fn(),
      client: vi.fn(),
      materializeBlueprint: vi.fn(),
    };
    expect(selectAdapter(runtime, { aws, gcp: ctx }).engine).toBe("infra-manager");
    expect(() => selectAdapter(runtime, { aws })).toThrow(RuntimeNotSupportedError);
  });
});
