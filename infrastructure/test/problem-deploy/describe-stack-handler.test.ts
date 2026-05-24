import type { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { describeStackForDeployment } from "../../lib/problem-deploy/handlers/describe-stack-handler";

const input = {
  detail: {
    jobId: "01KRK6BATCE8QZHX663MQFX4E3",
    tenantId: "tenant-acme",
    namePrefix: "tc-microservice-migration-battle-team-1",
    region: "ap-northeast-1",
  },
};

function deps(options: { externalId?: string } = {}) {
  const ssmSend = vi.fn(async () => ({
    Parameter: { Value: options.externalId ?? "external", Version: 3 },
  }));
  const stsSend = vi.fn(async () => ({
    Credentials: {
      AccessKeyId: "AKIA",
      SecretAccessKey: "secret",
      SessionToken: "token",
    },
  }));
  const cfnSend = vi.fn(async () => ({
    Stacks: [
      {
        StackId:
          "arn:aws:cloudformation:ap-northeast-1:449699636068:stack/tc-microservice-migration-battle-team-1/uuid",
        StackStatus: "CREATE_COMPLETE",
        Outputs: [{ OutputKey: "ParticipantViewerRoleArn", OutputValue: "arn:aws:iam::x:role/y" }],
      },
    ],
  }));
  const cfnClient = vi.fn(() => ({ send: cfnSend }));
  return {
    deps: {
      ssm: { send: ssmSend },
      sts: { send: stsSend },
      cfnClient,
    },
    ssmSend,
    stsSend,
    cfnSend,
    cfnClient,
  };
}

describe("describeStackForDeployment input-shape diagnostics (regression #?)", () => {
  it("should emit deploy.describe-stack.input-received at error level when detail.jobId is undefined and preserve the existing missing-required-field error", async () => {
    const { deps: d } = deps();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        describeStackForDeployment({ detail: { namePrefix: "x", region: "ap-northeast-1" } }, d),
      ).rejects.toThrow("missing required field: detail.jobId");
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      const traceCall = calls.find((c) => c.includes("deploy.describe-stack.input-received"));
      expect(traceCall).toBeDefined();
      // shape の non-secret な field のみが出ること (= jobId 自体は出ない)。
      expect(traceCall).toContain('"hasDetail":true');
      expect(traceCall).toContain('"hasJobId":false');
      expect(traceCall).toContain('"hasNamePrefix":true');
      expect(traceCall).toContain('"hasRegion":true');
      expect(traceCall).toContain('"detailKeys":"namePrefix,region"');
    } finally {
      errSpy.mockRestore();
    }
  });

  it("should still emit the shape log and report missing required field even when detail itself is undefined", async () => {
    const { deps: d } = deps();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(describeStackForDeployment({}, d)).rejects.toThrow(
        "missing required field: detail.jobId",
      );
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      const traceCall = calls.find((c) => c.includes("deploy.describe-stack.input-received"));
      expect(traceCall).toBeDefined();
      expect(traceCall).toContain('"hasDetail":false');
      expect(traceCall).toContain('"hasJobId":false');
      expect(traceCall).toContain('"detailKeys":""');
    } finally {
      errSpy.mockRestore();
    }
  });

  it("should not emit the shape log on the normal path (jobId / namePrefix / region all present)", async () => {
    const { deps: d } = deps();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await describeStackForDeployment(input, d);
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      const traceCall = calls.find((c) => c.includes("deploy.describe-stack.input-received"));
      expect(traceCall).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("describeStackForDeployment", () => {
  it("should DescribeStacks after AssumeRole with ExternalId when competitorRoleArn is set", async () => {
    const { deps: d, ssmSend, stsSend, cfnSend, cfnClient } = deps();

    const out = await describeStackForDeployment(
      {
        detail: {
          ...input.detail,
          competitorRoleArn: "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
          externalIdParameterName: "/development/tenants/tenant-acme/external-id",
        },
      },
      d,
    );

    expect(out.Stacks?.[0]?.StackStatus).toBe("CREATE_COMPLETE");
    expect(ssmSend.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(stsSend.mock.calls[0]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    const assume = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(assume.input.ExternalId).toBe("external");
    expect(assume.input.RoleArn).toBe(
      "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(cfnClient).toHaveBeenCalledWith({
      region: "ap-northeast-1",
      credentials: {
        AccessKeyId: "AKIA",
        SecretAccessKey: "secret",
        SessionToken: "token",
      },
    });
    const describeCmd = cfnSend.mock.calls[0]?.[0] as DescribeStacksCommand;
    expect(describeCmd.input.StackName).toBe("tc-microservice-migration-battle-team-1");
  });

  it("should fall back to same-account DescribeStacks for legacy events without AssumeRole metadata", async () => {
    const { deps: d, ssmSend, stsSend, cfnClient } = deps();

    await describeStackForDeployment(input, d);

    expect(ssmSend).not.toHaveBeenCalled();
    expect(stsSend).not.toHaveBeenCalled();
    expect(cfnClient).toHaveBeenCalledWith({
      region: "ap-northeast-1",
      credentials: undefined,
    });
  });

  it("should raise a config error if only one side of the AssumeRole metadata is present", async () => {
    const { deps: d } = deps();

    await expect(
      describeStackForDeployment(
        {
          detail: {
            ...input.detail,
            competitorRoleArn: "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
          },
        },
        d,
      ),
    ).rejects.toThrow("competitorRoleArn and externalIdParameterName must be provided together");
  });

  it("should retry with the previous generation when AssumeRole fails with AccessDenied (rotation race window)", async () => {
    const { deps: d, ssmSend, stsSend } = deps();
    ssmSend
      .mockResolvedValueOnce({ Parameter: { Value: "current", Version: 3 } })
      .mockResolvedValueOnce({ Parameter: { Value: "previous", Version: 2 } });
    const accessDenied = Object.assign(new Error("not authorized"), { name: "AccessDenied" });
    stsSend.mockRejectedValueOnce(accessDenied).mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIA2",
        SecretAccessKey: "secret2",
        SessionToken: "token2",
      },
    });

    await describeStackForDeployment(
      {
        detail: {
          ...input.detail,
          competitorRoleArn: "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
          externalIdParameterName: "/development/tenants/tenant-acme/external-id",
        },
      },
      d,
    );

    expect(ssmSend).toHaveBeenCalledTimes(2);
    const previousGet = ssmSend.mock.calls[1]?.[0] as GetParameterCommand;
    expect(previousGet.input.Name).toBe("/development/tenants/tenant-acme/external-id:2");
    const retryAssume = stsSend.mock.calls[1]?.[0] as AssumeRoleCommand;
    expect(retryAssume.input.ExternalId).toBe("previous");
    // ExternalId は常に retry でも渡されること (= 「ExternalId 無し AssumeRole」は禁止)
    expect(retryAssume.input.ExternalId).toBeDefined();
  });

  it("should NOT retry with the previous generation when AssumeRole fails with a non-AccessDenied error (= no blanket band-aid)", async () => {
    const { deps: d, ssmSend, stsSend } = deps();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "current", Version: 3 } });
    const throttling = Object.assign(new Error("rate exceeded"), { name: "ThrottlingException" });
    stsSend.mockRejectedValueOnce(throttling);

    await expect(
      describeStackForDeployment(
        {
          detail: {
            ...input.detail,
            competitorRoleArn: "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
            externalIdParameterName: "/development/tenants/tenant-acme/external-id",
          },
        },
        d,
      ),
    ).rejects.toThrow("rate exceeded");
    // SSM は current version 1 回しか引かれない (= previous version の SSM lookup 自体起きない)
    expect(ssmSend).toHaveBeenCalledTimes(1);
    // STS も 1 回しか発火しない (= retry なし)
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it("should emit deploy.describe-stack.assume-role.grace-fallback at error level so operators can alarm on rotation-race retries", async () => {
    const { deps: d, ssmSend, stsSend } = deps();
    ssmSend
      .mockResolvedValueOnce({ Parameter: { Value: "current", Version: 5 } })
      .mockResolvedValueOnce({ Parameter: { Value: "previous", Version: 4 } });
    const accessDenied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    stsSend.mockRejectedValueOnce(accessDenied).mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIA2",
        SecretAccessKey: "secret2",
        SessionToken: "token2",
      },
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await describeStackForDeployment(
        {
          detail: {
            ...input.detail,
            competitorRoleArn: "arn:aws:iam::449699636068:role/TenkaCloud-CompetitorDeploy-Role",
            externalIdParameterName: "/development/tenants/tenant-acme/external-id",
          },
        },
        d,
      );
      const errCalls = errSpy.mock.calls.map((c) => String(c[0]));
      const graceErr = errCalls.find((c) =>
        c.includes("deploy.describe-stack.assume-role.grace-fallback"),
      );
      expect(graceErr).toBeDefined();
      expect(graceErr).toContain('"level":"error"');
      expect(graceErr).toContain('"externalIdVersion":4');
      expect(graceErr).toContain('"reason":"AccessDeniedException"');
      // band-aid だった silent console.warn は撤去済 (warn では出ない)
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((c) => c.includes("grace_fallback_used"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
