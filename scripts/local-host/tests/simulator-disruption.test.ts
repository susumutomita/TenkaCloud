import { expect, test } from "bun:test";
import { AwsDisruptionAdapter } from "../aws-disruption-adapter";
import { CloudFormationEngine, type CloudFormationEngineOptions } from "../cloudformation-engine";
import type { DisruptionTarget } from "../disruption-model";

function fixture() {
  const calls = { sts: 0, ssm: 0, factory: 0 };
  const sts = {
    send: async () => {
      calls.sts++;
      return {
        Credentials: {
          AccessKeyId: "synthetic",
          SecretAccessKey: "synthetic",
          SessionToken: "synthetic",
        },
      };
    },
  };
  const ssm = {
    send: async () => {
      calls.ssm++;
      return { Command: { CommandId: "configured-local-client" } };
    },
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
      calls.factory++;
      return ssm as never;
    },
    team: () => {
      throw new Error("not used");
    },
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  };
  return { calls, options };
}

const target: DisruptionTarget = {
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
  inject: {
    kind: "ssm-run-command",
    target: "i-fixture",
    documentName: "AWS-RunShellScript",
    params: { commands: ["echo fixture"] },
  },
};

const submission = {
  target,
  dispatch: target.inject,
  operationKey: "fixture-operation",
  assertCurrent: () => undefined,
};

test("disruption transport uses its configured SSM factory, never the ambient client", async () => {
  const { calls, options } = fixture();
  // Transport remains tested independently of the simulator's unavailable runtime capability.
  const adapter = new AwsDisruptionAdapter(
    { sts: options.sts, ssm: options.ssm },
    options.externalId,
  );
  expect(await adapter.submit(submission)).toEqual({
    kind: "accepted",
    operationId: "configured-local-client",
  });
  expect(calls).toEqual({ sts: 1, ssm: 1, factory: 1 });
});

test("simulator still refuses an absent explicit SSM transport rather than falling back", () => {
  const { calls, options } = fixture();
  const engine = new CloudFormationEngine(process.cwd(), { ...options, ssm: undefined });
  expect(() => engine.disruptionAdapter()).toThrow("Simulator SSM transport is unavailable");
  expect(calls).toEqual({ sts: 0, ssm: 0, factory: 0 });
});

test("simulator disruption capability refuses submit, observe and discovery before STS or SSM", async () => {
  const { calls, options } = fixture();
  const adapter = new CloudFormationEngine(process.cwd(), options).disruptionAdapter();
  const reason =
    "AWS disruptions are unavailable in simulator mode. Retained operations require recovery in their original supported hosting mode.";
  expect(await adapter.submit(submission)).toEqual({ kind: "rejected", reason });
  expect(await adapter.observe({ target, operationId: "retained-command" })).toEqual({
    kind: "unknown",
    reason,
  });
  expect(await adapter.discover({ ...submission, sentAt: 0 })).toEqual({
    kind: "unknown",
    reason,
  });
  expect(calls).toEqual({ sts: 0, ssm: 0, factory: 0 });
});

test.each(["submit", "observe", "discover"] as const)(
  "%s checks trusted origin before any credentials",
  async (operation) => {
    const { calls, options } = fixture();
    let reads = 0;
    const adapter = new CloudFormationEngine(process.cwd(), {
      ...options,
      simulatorEndpoint: undefined,
    }).disruptionAdapter(() => {
      reads++;
      throw new Error("current origin rejected");
    });
    const actions = {
      submit: () => adapter.submit(submission),
      observe: () => adapter.observe({ target, operationId: "retained" }),
      discover: () => adapter.discover({ ...submission, sentAt: 0 }),
    };
    const result = await actions[operation]();
    expect(result.kind).toBe(operation === "submit" ? "rejected" : "unknown");
    expect(reads).toBe(1);
    expect(calls).toEqual({ sts: 0, ssm: 0, factory: 0 });
  },
);

test("origin is rechecked after asynchronous STS before creating an SSM client", async () => {
  const { calls, options } = fixture();
  let reads = 0;
  const adapter = new CloudFormationEngine(process.cwd(), {
    ...options,
    simulatorEndpoint: undefined,
  }).disruptionAdapter(() => {
    if (++reads === 2) throw new Error("generation changed during STS");
  });
  expect((await adapter.observe({ target, operationId: "retained" })).kind).toBe("unknown");
  expect(reads).toBe(2);
  expect(calls).toEqual({ sts: 1, ssm: 0, factory: 0 });
});

test.each([
  { operation: "observe", more: true },
  { operation: "observe", more: false },
  { operation: "discover", more: true },
  { operation: "discover", more: false },
  { operation: "submit", more: false },
] as const)(
  "$operation rejects origin changes during SSM response (more=$more)",
  async ({ operation, more }) => {
    const { calls, options } = fixture();
    let current = true;
    let sends = 0;
    let destroyed = 0;
    const ssmFixture = {
      send: async () => {
        sends++;
        current = false;
        return {
          Status: "Success",
          Command: { CommandId: "accepted-before-origin-change" },
          Commands: [
            {
              CommandId: "matching-retained-command",
              Comment: submission.operationKey,
              DocumentName: "AWS-RunShellScript",
              InstanceIds: ["i-fixture"],
              Parameters: { commands: ["echo fixture"] },
              RequestedDateTime: new Date(0),
            },
          ],
          ...(more ? { NextToken: "next-page" } : {}),
        };
      },
      destroy: () => {
        destroyed++;
      },
    };
    const adapter = new CloudFormationEngine(process.cwd(), {
      ...options,
      simulatorEndpoint: undefined,
      ssm: () =>
        ssmFixture as unknown as ReturnType<NonNullable<CloudFormationEngineOptions["ssm"]>>,
    }).disruptionAdapter(() => {
      if (!current) throw new Error("current deployment changed during SSM await");
    });
    const observationTarget = {
      ...target,
      inject: { ...target.inject, target: more ? "i-first,i-second" : "i-fixture" },
    };
    const actions = {
      submit: () => adapter.submit(submission),
      observe: () => adapter.observe({ target: observationTarget, operationId: "retained" }),
      discover: () => adapter.discover({ ...submission, sentAt: 0 }),
    };
    expect((await actions[operation]()).kind).toBe("unknown");
    expect(sends).toBe(1);
    expect(destroyed).toBe(1);
    expect(calls.sts).toBe(1);
  },
);
