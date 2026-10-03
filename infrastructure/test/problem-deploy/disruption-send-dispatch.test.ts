import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisruptionDispatch } from "../../lib/problem-deploy/handlers/disruption-executor-handler/dispatch-command";
import {
  type DispatchTarget,
  type SendDispatchDeps,
  sendDispatch,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/send-dispatch";

/**
 * [#1419] sendDispatch: DisruptionDispatch → 実 SDK command の mapping を mocked client で pin。
 * client factory は assumed-credential 付きで呼ばれること + 各 kind の command input を観察する。
 */

const target: DispatchTarget = {
  region: "ap-northeast-1",
  credentials: { AccessKeyId: "AK", SecretAccessKey: "SK", SessionToken: "ST" },
};

function makeDeps(): {
  deps: SendDispatchDeps;
  ssm: ReturnType<typeof vi.fn>;
  lambda: ReturnType<typeof vi.fn>;
  cfn: ReturnType<typeof vi.fn>;
  factories: Record<string, ReturnType<typeof vi.fn>>;
} {
  const ssm = vi.fn().mockResolvedValue({});
  const lambda = vi.fn().mockResolvedValue({});
  const cfn = vi.fn().mockResolvedValue({});
  const ssmFactory = vi.fn().mockReturnValue({ send: ssm });
  const lambdaFactory = vi.fn().mockReturnValue({ send: lambda });
  const cfnFactory = vi.fn().mockReturnValue({ send: cfn });
  return {
    deps: { ssmClient: ssmFactory, lambdaClient: lambdaFactory, cfnClient: cfnFactory },
    ssm,
    lambda,
    cfn,
    factories: { ssmFactory, lambdaFactory, cfnFactory },
  };
}

describe("sendDispatch (#1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should send SSM SendCommand with split InstanceIds and coerced string[] Parameters", async () => {
    const { deps, ssm, factories } = makeDeps();
    const dispatch: DisruptionDispatch = {
      kind: "ssm-run-command",
      target: "i-aaa, i-bbb ,",
      documentName: "AWS-RunShellScript",
      params: { commands: ["echo hi"], timeout: 30 },
    };
    await sendDispatch(dispatch, target, deps);
    expect(factories.ssmFactory).toHaveBeenCalledWith(target);
    const input = ssm.mock.calls[0][0].input;
    expect(input.DocumentName).toBe("AWS-RunShellScript");
    expect(input.InstanceIds).toEqual(["i-aaa", "i-bbb"]);
    expect(input.Parameters).toEqual({ commands: ["echo hi"], timeout: ["30"] });
  });

  it("should default the SSM document name when none is declared", async () => {
    const { deps, ssm } = makeDeps();
    await sendDispatch({ kind: "ssm-run-command", target: "i-x", params: {} }, target, deps);
    expect(ssm.mock.calls[0][0].input.DocumentName).toBe("AWS-RunShellScript");
  });

  it("should invoke Lambda asynchronously (Event) with the params as JSON payload", async () => {
    const { deps, lambda, factories } = makeDeps();
    await sendDispatch(
      { kind: "lambda-invoke", target: "fault-fn", params: { mode: "fail" } },
      target,
      deps,
    );
    expect(factories.lambdaFactory).toHaveBeenCalledWith(target);
    const input = lambda.mock.calls[0][0].input;
    expect(input.FunctionName).toBe("fault-fn");
    expect(input.InvocationType).toBe("Event");
    expect(new TextDecoder().decode(input.Payload)).toBe(JSON.stringify({ mode: "fail" }));
  });

  it("should update the CFn stack with UsePreviousTemplate + mapped Parameters + IAM capabilities", async () => {
    const { deps, cfn, factories } = makeDeps();
    await sendDispatch(
      { kind: "cfn-stack-update", target: "team-stack", params: { DesiredCount: 0 } },
      target,
      deps,
    );
    expect(factories.cfnFactory).toHaveBeenCalledWith(target);
    const input = cfn.mock.calls[0][0].input;
    expect(input.StackName).toBe("team-stack");
    expect(input.UsePreviousTemplate).toBe(true);
    expect(input.Parameters).toEqual([{ ParameterKey: "DesiredCount", ParameterValue: "0" }]);
    expect(input.Capabilities).toContain("CAPABILITY_NAMED_IAM");
  });

  it("should propagate SDK errors (fault injection failure is loud)", async () => {
    const { deps, ssm } = makeDeps();
    ssm.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(
      sendDispatch({ kind: "ssm-run-command", target: "i-x", params: {} }, target, deps),
    ).rejects.toThrow("AccessDenied");
  });

  // [#1710 / IAM audit] same-account (Lite) mode: `target.credentials` 不在。 executor role が
  // `ssm-run-command` しか許可していない kind は AccessDenied ではなく fail-closed で loud に落とす。
  describe("same-account (Lite) mode — no assumed credentials", () => {
    const liteTarget: DispatchTarget = { region: "ap-northeast-1" };

    it("should fail loudly for lambda-invoke instead of calling Lambda", async () => {
      const { deps, lambda, factories } = makeDeps();
      await expect(
        sendDispatch({ kind: "lambda-invoke", target: "fault-fn", params: {} }, liteTarget, deps),
      ).rejects.toThrow(/lambda-invoke.*not supported in same-account/);
      expect(factories.lambdaFactory).not.toHaveBeenCalled();
      expect(lambda).not.toHaveBeenCalled();
    });

    it("should fail loudly for cfn-stack-update instead of calling CloudFormation", async () => {
      const { deps, cfn, factories } = makeDeps();
      await expect(
        sendDispatch(
          { kind: "cfn-stack-update", target: "team-stack", params: {} },
          liteTarget,
          deps,
        ),
      ).rejects.toThrow(/cfn-stack-update.*not supported in same-account/);
      expect(factories.cfnFactory).not.toHaveBeenCalled();
      expect(cfn).not.toHaveBeenCalled();
    });

    it("should still run ssm-run-command (the one kind the Lite executor role grants)", async () => {
      const { deps, ssm, factories } = makeDeps();
      await sendDispatch({ kind: "ssm-run-command", target: "i-x", params: {} }, liteTarget, deps);
      expect(factories.ssmFactory).toHaveBeenCalledWith(liteTarget);
      expect(ssm).toHaveBeenCalledTimes(1);
    });
  });
});
