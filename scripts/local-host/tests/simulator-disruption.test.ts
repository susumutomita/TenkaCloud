import { expect, test } from "bun:test";
import { CloudFormationEngine, type CloudFormationEngineOptions } from "../cloudformation-engine";

test("simulator disruption uses its configured SSM factory, never the ambient client", async () => {
  let calls = 0;
  const sts = {
    send: async () => ({
      Credentials: {
        AccessKeyId: "synthetic",
        SecretAccessKey: "synthetic",
        SessionToken: "synthetic",
      },
    }),
  };
  const ssm = {
    send: async () => ({ Command: { CommandId: "configured-local-client" } }),
    destroy: () => undefined,
  };
  const options: CloudFormationEngineOptions = {
    simulatorEndpoint: "http://127.0.0.1:1",
    region: "ap-northeast-1",
    externalId: "fixture-external-id-0123456789",
    operatorAccountId: async () => "999999999999",
    sts: sts as never,
    cloudFormation: () => {
      throw new Error("not used");
    },
    ssm: () => {
      calls++;
      return ssm as never;
    },
    team: () => {
      throw new Error("not used");
    },
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  };
  const engine = new CloudFormationEngine(process.cwd(), options);
  const unavailable = new CloudFormationEngine(process.cwd(), { ...options, ssm: undefined });
  expect(() => unavailable.disruptionAdapter()).toThrow("Simulator SSM transport is unavailable");
  const result = await engine.disruptionAdapter().submit({
    target: {
      jobId: "fixture-job",
      eventId: "event",
      teamId: "team",
      stackId: "stack",
      unitHash: "hash",
      deployedAt: 0,
      accountId: "000000000000",
      resources: [],
      afterSeconds: 0,
      revert: { kind: "ssm-run-command", target: "i-fixture", params: {} },
      roleArn: "arn:aws:iam::000000000000:role/fixture",
      region: "ap-northeast-1",
      inject: { kind: "ssm-run-command", target: "i-fixture", params: {} },
    },
    dispatch: {
      kind: "ssm-run-command",
      target: "i-fixture",
      documentName: "AWS-RunShellScript",
      params: { commands: ["echo fixture"] },
    },
    operationKey: "fixture-operation",
    assertCurrent: () => undefined,
  });
  expect(calls).toBe(1);
  expect(result).toEqual({ kind: "accepted", operationId: "configured-local-client" });
});
