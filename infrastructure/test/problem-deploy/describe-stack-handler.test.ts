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
  it("detail.jobId が undefined のとき deploy.describe-stack.input-received を error level で emit し、 既存の missing required field エラーを保つべき", async () => {
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

  it("detail 自体が undefined のときも shape log を emit して missing required field を保つべき", async () => {
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

  it("正常 path (= jobId / namePrefix / region 全部揃う) では shape log を出さないべき", async () => {
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
  it("competitorRoleArn がある場合は ExternalId 付き AssumeRole 後に DescribeStacks すべき", async () => {
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

  it("AssumeRole metadata が無い旧 event は same-account DescribeStacks に倒すべき", async () => {
    const { deps: d, ssmSend, stsSend, cfnClient } = deps();

    await describeStackForDeployment(input, d);

    expect(ssmSend).not.toHaveBeenCalled();
    expect(stsSend).not.toHaveBeenCalled();
    expect(cfnClient).toHaveBeenCalledWith({
      region: "ap-northeast-1",
      credentials: undefined,
    });
  });

  it("AssumeRole metadata が片方だけなら構成エラーにすべき", async () => {
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

  it("current ExternalId で AssumeRole が失敗したら 1 世代前で再試行すべき", async () => {
    const { deps: d, ssmSend, stsSend } = deps();
    ssmSend
      .mockResolvedValueOnce({ Parameter: { Value: "current", Version: 3 } })
      .mockResolvedValueOnce({ Parameter: { Value: "previous", Version: 2 } });
    stsSend.mockRejectedValueOnce(new Error("AccessDenied")).mockResolvedValueOnce({
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
  });
});
