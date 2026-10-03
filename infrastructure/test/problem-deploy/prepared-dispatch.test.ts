/**
 * [Composite Runtime / Issue #2064] Tests for the prepared-dispatch seam.
 *
 * Provider-specific dispatch (AWS EventBridge detail / GCP WIF + Infra Manager /
 * Azure ARM / Sakura AppRun) and the "single deployment start behaviour is
 * unchanged" / "identical EventBridge detail before and after extraction"
 * contracts are already covered end-to-end by `deploy-runtime-dispatch.test.ts`
 * and `composite-compat-single-provider.test.ts`, which exercise `startDeployment`
 * through the real adapters and remain green after this extraction. These tests
 * pin the seam itself: payload mapping, error passthrough, and the absence of any
 * row mutation.
 */

import { describe, expect, it, vi } from "vitest";
import {
  dispatchPreparedDeployment,
  type PreparedDeploymentDispatch,
} from "../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch";
import type { RuntimeDeployInput } from "../../lib/problem-deploy/handlers/shared/runtime/adapter";

function makeAdapter() {
  const deploy = vi.fn(async (_input: RuntimeDeployInput) => ({ status: "IN_PROGRESS" as const }));
  return { deploy };
}

function prepared(over: Partial<PreparedDeploymentDispatch> = {}): PreparedDeploymentDispatch {
  return {
    adapter: makeAdapter(),
    jobId: "job-1",
    tenantId: "tenant-acme",
    problemId: "cross-cloud",
    problemDir: "problems/challenges/cross-cloud",
    teamSlug: "alpha",
    namePrefix: "tc-cross-cloud-alpha",
    region: "ap-northeast-1",
    awsAccountId: "123456789012",
    ...over,
  };
}

describe("dispatchPreparedDeployment (#2064)", () => {
  it("forwards the prepared job to the adapter with correlationId = jobId", async () => {
    const adapter = makeAdapter();
    await dispatchPreparedDeployment(prepared({ adapter }));

    expect(adapter.deploy).toHaveBeenCalledTimes(1);
    expect(adapter.deploy).toHaveBeenCalledWith({
      jobId: "job-1",
      correlationId: "job-1",
      tenantId: "tenant-acme",
      problemId: "cross-cloud",
      problemDir: "problems/challenges/cross-cloud",
      teamSlug: "alpha",
      namePrefix: "tc-cross-cloud-alpha",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
    });
  });

  it("includes the AWS-only and challenge fields when present", async () => {
    const adapter = makeAdapter();
    await dispatchPreparedDeployment(
      prepared({
        adapter,
        competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
        externalIdParameterName: "/test/tenants/tenant-acme/external-id",
        challengePayloadUrl: "https://example/payload.zip",
      }),
    );

    expect(adapter.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
        externalIdParameterName: "/test/tenants/tenant-acme/external-id",
        challengePayloadUrl: "https://example/payload.zip",
      }),
    );
  });

  it("omits the optional fields entirely when not provided (legacy byte shape)", async () => {
    const adapter = makeAdapter();
    await dispatchPreparedDeployment(prepared({ adapter }));

    const payload = adapter.deploy.mock.calls[0]?.[0] as RuntimeDeployInput;
    expect(Object.keys(payload)).not.toContain("competitorRoleArn");
    expect(Object.keys(payload)).not.toContain("externalIdParameterName");
    expect(Object.keys(payload)).not.toContain("challengePayloadUrl");
  });

  it("rethrows the adapter error unchanged (caller owns compensation)", async () => {
    const boom = new Error("adapter failed to publish");
    const adapter = { deploy: vi.fn(async () => Promise.reject(boom)) };
    await expect(dispatchPreparedDeployment(prepared({ adapter }))).rejects.toBe(boom);
  });

  it("dispatches through exactly one adapter call and nothing else", async () => {
    // The seam has no DynamoDB / id / timestamp dependency — its only effect is
    // the single adapter.deploy invocation.
    const adapter = makeAdapter();
    await dispatchPreparedDeployment(prepared({ adapter }));
    expect(adapter.deploy).toHaveBeenCalledTimes(1);
  });
});
