import { beforeEach, describe, expect, it, vi } from "vitest";

const errorDeployTrace = vi.fn();
vi.mock("../../lib/problem-deploy/handlers/shared/trace-log", () => ({
  errorDeployTrace: (...args: unknown[]) => errorDeployTrace(...args),
  logDeployTrace: vi.fn(),
}));

import {
  type AssumeCompetitorRoleDeps,
  assumeCompetitorRole,
  shouldRetryWithPreviousExternalIdVersion,
} from "../../lib/problem-deploy/handlers/shared/assume-competitor-role";

/**
 * 共有 assumeCompetitorRole の挙動 pin。 describe-stack-handler の既存 test が回帰網だが、 ここでは
 * 共有契約 + parameterize した cosmetic (sessionNamePrefix / graceFallbackTraceEvent) を直接確認する。
 */

const CREDS = { AccessKeyId: "AK", SecretAccessKey: "SK", SessionToken: "ST" };

function makeDeps(
  ssmSend: ReturnType<typeof vi.fn>,
  stsSend: ReturnType<typeof vi.fn>,
): AssumeCompetitorRoleDeps {
  return {
    ssm: { send: ssmSend } as unknown as AssumeCompetitorRoleDeps["ssm"],
    sts: { send: stsSend } as unknown as AssumeCompetitorRoleDeps["sts"],
  };
}

const baseParams = {
  region: "ap-northeast-1",
  jobId: "job-1234567890123456789012345678",
  competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-1/external-id",
  sessionNamePrefix: "tc-disruption-",
  graceFallbackTraceEvent: "deploy.disruption-executor.assume-role.grace-fallback",
};

describe("assumeCompetitorRole (shared)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return undefined when neither competitorRoleArn nor externalIdParameterName is given", async () => {
    const deps = makeDeps(vi.fn(), vi.fn());
    expect(
      await assumeCompetitorRole(deps, {
        ...baseParams,
        competitorRoleArn: undefined,
        externalIdParameterName: undefined,
      }),
    ).toBeUndefined();
  });

  it("should throw when only one side of the cross-account metadata is present", async () => {
    const deps = makeDeps(vi.fn(), vi.fn());
    await expect(
      assumeCompetitorRole(deps, { ...baseParams, externalIdParameterName: undefined }),
    ).rejects.toThrow("must be provided together");
  });

  it("should throw when the SSM ExternalId parameter has no value", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue({ Parameter: {} }), vi.fn());
    await expect(assumeCompetitorRole(deps, baseParams)).rejects.toThrow(
      "ExternalId not found in SSM SecureString",
    );
  });

  it("should AssumeRole with the caller's session-name prefix (truncated jobId) and return the creds", async () => {
    const ssm = vi.fn().mockResolvedValue({ Parameter: { Value: "ext-id", Version: 3 } });
    const sts = vi.fn().mockResolvedValue({ Credentials: CREDS });
    expect(await assumeCompetitorRole(makeDeps(ssm, sts), baseParams)).toEqual(CREDS);
    const input = sts.mock.calls[0][0].input;
    expect(input.RoleSessionName).toBe(`tc-disruption-${baseParams.jobId.slice(0, 24)}`);
    expect(input.ExternalId).toBe("ext-id");
    expect(input.DurationSeconds).toBe(900);
  });

  it("should throw when AssumeRole returns incomplete credentials", async () => {
    const ssm = vi.fn().mockResolvedValue({ Parameter: { Value: "ext-id", Version: 1 } });
    const sts = vi.fn().mockResolvedValue({ Credentials: { AccessKeyId: "AK" } });
    await expect(assumeCompetitorRole(makeDeps(ssm, sts), baseParams)).rejects.toThrow(
      "incomplete credentials",
    );
  });

  it("should grace-fallback to the previous ExternalId version on AccessDenied and fire the caller's trace event", async () => {
    const ssm = vi
      .fn()
      .mockResolvedValueOnce({ Parameter: { Value: "new-id", Version: 4 } })
      .mockResolvedValueOnce({ Parameter: { Value: "old-id", Version: 3 } });
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    const sts = vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce({ Credentials: CREDS });
    expect(await assumeCompetitorRole(makeDeps(ssm, sts), baseParams)).toEqual(CREDS);
    expect(ssm.mock.calls[1][0].input.Name).toBe(`${baseParams.externalIdParameterName}:3`);
    expect(errorDeployTrace).toHaveBeenCalledWith(
      "deploy.disruption-executor.assume-role.grace-fallback",
      expect.objectContaining({ externalIdVersion: 3, reason: "AccessDenied" }),
    );
  });

  it("should rethrow immediately on a non-AccessDenied error (no blanket band-aid)", async () => {
    const ssm = vi.fn().mockResolvedValue({ Parameter: { Value: "id", Version: 2 } });
    const sts = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("slow"), { name: "ThrottlingException" }));
    await expect(assumeCompetitorRole(makeDeps(ssm, sts), baseParams)).rejects.toThrow("slow");
    expect(errorDeployTrace).not.toHaveBeenCalled();
  });

  it("should rethrow the original error when there is no previous version to fall back to", async () => {
    const ssm = vi.fn().mockResolvedValue({ Parameter: { Value: "id", Version: 1 } });
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    const sts = vi.fn().mockRejectedValue(denied);
    await expect(assumeCompetitorRole(makeDeps(ssm, sts), baseParams)).rejects.toThrow("denied");
  });
});

describe("shouldRetryWithPreviousExternalIdVersion", () => {
  it("should retry only on the AccessDenied family", () => {
    for (const name of ["AccessDenied", "AccessDeniedException", "Forbidden"]) {
      expect(shouldRetryWithPreviousExternalIdVersion(Object.assign(new Error(), { name }))).toBe(
        true,
      );
    }
    expect(
      shouldRetryWithPreviousExternalIdVersion(
        Object.assign(new Error(), { name: "ThrottlingException" }),
      ),
    ).toBe(false);
    expect(shouldRetryWithPreviousExternalIdVersion("not-an-error")).toBe(false);
  });
});
