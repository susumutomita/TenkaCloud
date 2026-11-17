import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsDisruptionAdapter } from "../aws-disruption-adapter";
import { unitOf } from "../cloud-runtime-contract";
import {
  CloudFormationEngine,
  type CloudFormationEngineOptions,
  type CredentialsProvider,
} from "../cloudformation-engine";
import { pinDisruption } from "../disruption-catalog";
import type { DisruptionTarget } from "../disruption-model";
import { DisruptionRunner } from "../disruption-runner";
import { DisruptionStore } from "../disruption-store";
import type { Job, Team } from "../model";
import type { SimulatorAuthority } from "../simulator-authority";
import type { SimulatorBattle } from "../simulator-battle";
import { HostStore } from "../store";
import { DisruptionAws } from "./disruption-fixture";
import { FakeAws } from "./fake-aws";

const root = join(import.meta.dirname, "../../..");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const binding = (authorityId: string, generation = 1): SimulatorAuthority => ({
  authorityId,
  generation,
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing authority fixture value");
  return value;
}

function request(store: DisruptionStore, requestId: string) {
  store.putRequest({
    eventId: "event",
    requestId,
    fingerprint: "fixture",
    auditId: "fixture",
    firedBy: "organizer",
    firedAt: new Date().toISOString(),
    input: {
      requestId,
      problemId: "hello-world-battle",
      disruptionId: "frontend-down",
      scope: "team",
      timing: "immediate",
      targetTeamIds: ["alpha", "beta"],
    },
    targetTeamIds: ["alpha", "beta"],
    parameters: {},
    dueAt: 0,
    endsAt: 0,
    cancelled: false,
  });
}

function fakeCloudFormation(aws: FakeAws, transportCalls: string[]) {
  return (credentials: CredentialsProvider) => {
    let cached: Awaited<ReturnType<CredentialsProvider>> | undefined;
    return {
      send: async (command: unknown) => {
        cached ??= await credentials();
        transportCalls.push((command as { constructor: { name: string } }).constructor.name);
        return aws.cloudFormation(async () => required(cached)).send(command);
      },
    };
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tc-authority-"));
  const path = join(directory, "host.sqlite");
  let store = new HostStore(new Database(path));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const lanes = ["alpha", "beta"].map((name) => {
    const aws = new FakeAws();
    const disruption = new DisruptionAws();
    const calls: string[] = [];
    const transportCalls: string[] = [];
    const battle: SimulatorBattle = {
      clockDomain: "same-host-clock",
      probe: () => async () => {
        calls.push("probe");
        return { ok: true, status: 200, responseTimeMs: 1 };
      },
      seal: async () => {
        calls.push("seal");
      },
      terminal: async () => {
        calls.push("terminal");
        return {
          code: "fixture-code",
          terminalUrl: "http://127.0.0.1:4566/terminal",
          expiresAt: new Date().toISOString(),
        };
      },
    };
    const options: CloudFormationEngineOptions = {
      simulatorAuthority: binding(name),
      // Deliberately identical endpoint and AWS identifiers; only the connection bundle differs.
      simulatorEndpoint: "http://127.0.0.1:4566",
      simulatorBattle: battle,
      simulatorServices: ["sts", "iam", "cloudformation", "ssm"],
      region: "ap-northeast-1",
      externalId: "fixture-external-id-0123456789",
      operatorAccountId: async () => "999999999999",
      sts: aws.sts as never,
      cloudFormation: fakeCloudFormation(aws, transportCalls) as never,
      ssm: disruption.ssm as never,
      team: (job) => store.team(job.teamId),
      sleep: async () => undefined,
      pollIntervalMs: 0,
      timeoutMs: 1000,
    };
    return { name, aws, disruption, calls, transportCalls, options };
  });
  const alpha = required(lanes[0]);
  const beta = required(lanes[1]);
  let engines = new Map<string, CloudFormationEngine>();
  const resolve = (identity: SimulatorAuthority) => engines.get(identity.authorityId);
  function connect() {
    engines = new Map(
      lanes.map((lane) => [
        lane.name,
        new CloudFormationEngine(root, {
          ...lane.options,
          simulatorAuthorityEngine: resolve,
        }),
      ]),
    );
  }
  connect();
  const cloud = () => required(engines.get("alpha"));
  const problem = required(
    cloud()
      .catalog()
      .find((p) => p.problemId === "hello-world-battle"),
  );
  store.putEvent({
    eventId: "event",
    name: "authority fixture",
    status: "READY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startsAt: new Date(0).toISOString(),
    expiresAt: 9999999999,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem],
  });
  for (const lane of lanes) {
    const team: Team = {
      teamId: lane.name,
      eventId: "event",
      internalSlug: lane.name,
      displayName: lane.name,
      loginKey: `fixture-${lane.name}-key`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: {
        accountId: "000000000000",
        roleName: "TenkaCloud-SimulatorDeploy-Role",
        simulatorAuthority: binding(lane.name),
      },
    };
    store.putTeam(team);
    const stack = lane.aws.seedStack("same-stack", [
      { Key: "tenkacloud:job", Value: lane.name.padEnd(26, "0") },
    ]);
    // Same stack ARN, account, role and instance ID in each independent fake transport.
    stack.stackId = "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/same-stack/0";
    const job: Job = {
      jobId: lane.name.padEnd(26, "0"),
      teamId: lane.name,
      eventId: "event",
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      deployedAt: 1000,
      unit: JSON.stringify({
        kind: "cloudformation",
        simulatorAuthority: binding(lane.name),
        accountId: "000000000000",
        roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
        region: "ap-northeast-1",
        stackName: stack.name,
        stackId: stack.stackId,
        outputs: {
          InstanceId: "i-0123456789abcdef0",
          Ec2HostHint: "same.simulator.invalid",
          ParticipantViewerRoleArn: "arn:aws:iam::000000000000:role/same-viewer",
        },
      }),
    };
    store.putJob(job);
  }
  return {
    alpha,
    beta,
    cloud,
    problem,
    job: (name: string) => store.job(name.padEnd(26, "0")),
    store: () => store,
    engines: () => engines,
    restart: () => {
      store.close();
      store = new HostStore(new Database(path));
      connect();
    },
  };
}

function target(job: Job): DisruptionTarget {
  const unit = unitOf(job);
  return {
    simulatorAuthority: unit.simulatorAuthority,
    jobId: job.jobId,
    teamId: job.teamId,
    eventId: job.eventId,
    stackId: required(unit.stackId),
    unitHash: "fixture-hash",
    deployedAt: required(job.deployedAt),
    accountId: unit.accountId,
    roleArn: unit.roleArn,
    region: unit.region,
    resources: ["same-resource"],
    afterSeconds: 600,
    inject: {
      kind: "ssm-run-command",
      target: "i-0123456789abcdef0",
      params: { commands: ["stop nginx"] },
    },
    revert: {
      kind: "ssm-run-command",
      target: "i-0123456789abcdef0",
      params: { commands: ["start nginx"] },
    },
  };
}
const current = () => undefined;

test("an explicit binding is retained before CreateStack, including an ambiguous failure", async () => {
  const f = fixture();
  const job: Job = { ...f.job("beta"), unit: null, status: "PENDING" };
  let retained: string | null = null;
  f.beta.aws.beforeCreate = () => {
    expect(JSON.parse(required(retained)).simulatorAuthority).toEqual(binding("beta"));
    throw new Error("ambiguous create");
  };
  await expect(
    f.cloud().start(job, (unit) => {
      retained = unit;
      job.unit = unit;
    }),
  ).rejects.toThrow("ambiguous create");
  expect(f.alpha.aws.assumed).toHaveLength(0);
  expect(f.beta.aws.created).toHaveLength(1);
});

test("restart selects the original whole transport for terminal, CLI, probes, recover and teardown", async () => {
  const f = fixture();
  f.restart();
  const beta = f.job("beta");
  expect(unitOf(beta).simulatorAuthority).toEqual(binding("beta"));
  await f.cloud().recover(beta);
  const cli = await f
    .cloud()
    .participantAwsAccess({ kind: "cli", job: beta, assertCurrent: current });
  expect(cli).toMatchObject({ kind: "cli", credentials: { endpointUrl: "http://127.0.0.1:4566" } });
  await f.cloud().participantAwsAccess({ kind: "terminal", job: beta, assertCurrent: current });
  await required(f.cloud().uptimeProbe(beta))("https://same.simulator.invalid/");
  await f.cloud().stop(beta);
  expect(f.beta.calls).toEqual(["terminal", "probe", "seal"]);
  expect(f.beta.aws.deleted).toHaveLength(1);
  expect(f.alpha.calls).toEqual([]);
  expect(f.alpha.aws.assumed).toEqual([]);
  await f.cloud().recover(f.job("alpha"));
  expect(f.alpha.aws.deleted).toEqual([]);
});

test.each(["missing", "unknown", "generation", "retained", "foreign"])(
  "%s binding fails before any transport",
  async (kind) => {
    const f = fixture();
    const job = f.job("beta");
    const unit = unitOf(job);
    if (kind === "missing") delete unit.simulatorAuthority;
    if (kind === "unknown") {
      unit.simulatorAuthority = binding("unknown");
      f.store().putTeam({
        ...f.store().team("beta"),
        aws: { ...required(f.store().team("beta").aws), simulatorAuthority: binding("unknown") },
      });
    }
    if (kind === "generation") {
      unit.simulatorAuthority = binding("beta", 2);
      f.store().putTeam({
        ...f.store().team("beta"),
        aws: { ...required(f.store().team("beta").aws), simulatorAuthority: binding("beta", 2) },
      });
    }
    if (kind === "retained") unit.simulatorAuthority = binding("alpha");
    if (kind === "foreign") job.teamId = "absent-team";
    job.unit = JSON.stringify(unit);
    await expect(f.cloud().recover(job)).rejects.toThrow();
    await expect(f.cloud().stop(job)).rejects.toThrow();
    await expect(
      f.cloud().participantAwsAccess({ kind: "terminal", job, assertCurrent: current }),
    ).rejects.toThrow();
    expect(() => f.cloud().uptimeProbe(job)).toThrow();
    expect(f.alpha.aws.assumed).toEqual([]);
    expect(f.beta.aws.assumed).toEqual([]);
    expect(f.alpha.calls).toEqual([]);
    expect(f.beta.calls).toEqual([]);
  },
);

test("a removed authority fails closed while the other remains operable", async () => {
  const f = fixture();
  f.engines().delete("beta");
  await expect(f.cloud().stop(f.job("beta"))).rejects.toMatchObject({
    kind: "simulator_authority_unavailable",
  });
  await f.cloud().recover(f.job("alpha"));
  expect(f.beta.aws.assumed).toEqual([]);
  expect(f.beta.aws.deleted).toEqual([]);
});

test("pending disruption targets survive SQLite restart and discover/observe/revert use the original authority", async () => {
  const f = fixture();
  const ds = new DisruptionStore(f.store());
  const beta = target(f.job("beta"));
  const adapter = f.cloud().disruptionAdapter();
  f.beta.disruption.timeoutNext = true;
  expect(
    await adapter.submit({
      target: beta,
      dispatch: beta.inject,
      operationKey: "same-operation",
      assertCurrent: current,
    }),
  ).toMatchObject({ kind: "unknown" });
  // Both processes have command-1 and matching discovery metadata.
  f.alpha.disruption.commands = structuredClone(f.beta.disruption.commands);
  request(ds, "request");
  ds.putExecution({
    id: "execution",
    eventId: "event",
    teamId: "beta",
    requestId: "request",
    tick: 1,
    status: "inject_unknown",
    reason: "ambiguous submission",
    dueAt: 0,
    updatedAt: 0,
    target: beta,
    inject: { key: "same-operation", sentAt: f.beta.disruption.now },
    revertAt: f.beta.disruption.now,
  });
  f.restart();
  const restored = new DisruptionStore(f.store());
  expect(restored.executions("event")[0]?.target.simulatorAuthority).toEqual(binding("beta"));
  const runner = new DisruptionRunner(
    restored,
    () => f.cloud().disruptionAdapter(),
    () => f.beta.disruption.now,
    current,
  );
  await runner.tick(); // discover and observe original injection
  await runner.tick(); // submit revert to beta
  await runner.tick(); // observe revert completion
  expect(restored.executions("event")[0]?.status).toBe("revert_command_completed");
  expect(f.beta.disruption.commands).toHaveLength(2);
  expect(f.beta.disruption.running.get("i-0123456789abcdef0")).toBe(true);
  expect(f.alpha.disruption.attempts).toEqual([]);
  expect(f.alpha.aws.assumed).toEqual([]);
});

test.each([undefined, binding("unknown"), binding("beta", 2)])(
  "unavailable disruption binding %j never contacts STS or SSM",
  async (identity) => {
    const f = fixture();
    const t = { ...target(f.job("beta")), simulatorAuthority: identity };
    const adapter = f.cloud().disruptionAdapter();
    expect(
      await adapter.submit({
        target: t,
        dispatch: t.inject,
        operationKey: "inject",
        assertCurrent: current,
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(
      await adapter.submit({
        target: t,
        dispatch: t.revert,
        operationKey: "revert",
        assertCurrent: current,
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(await adapter.observe({ target: t, operationId: "command-1" })).toMatchObject({
      kind: "unknown",
    });
    expect(
      await adapter.discover({ target: t, dispatch: t.inject, operationKey: "inject", sentAt: 0 }),
    ).toMatchObject({ kind: "unknown" });
    for (const lane of [f.alpha, f.beta]) {
      expect(lane.aws.assumed).toEqual([]);
      expect(lane.disruption.attempts).toEqual([]);
    }
  },
);

test("same resource IDs in different authorities do not block each other's disruption", async () => {
  const f = fixture();
  const ds = new DisruptionStore(f.store());
  for (const name of ["alpha", "beta"]) {
    request(ds, name);
    ds.putExecution({
      id: name,
      eventId: "event",
      teamId: name,
      requestId: name,
      tick: 1,
      dueAt: f.alpha.disruption.now,
      updatedAt: 0,
      target: target(f.job(name)),
      status: "queued",
    });
  }
  const runner = new DisruptionRunner(
    ds,
    () => f.cloud().disruptionAdapter(),
    () => f.alpha.disruption.now,
    current,
  );
  await runner.tick();
  expect(ds.executions("event").map((e) => e.status)).toEqual(["inject_pending", "inject_pending"]);
  expect(f.alpha.disruption.commands[0]?.CommandId).toBe("command-1");
  expect(f.beta.disruption.commands[0]?.CommandId).toBe("command-1");
});

test("pinDisruption retains authority rather than dropping it while parsing", () => {
  const f = fixture();
  const declaration = JSON.parse(f.problem.definition).disruptions[0];
  const pinned = pinDisruption({
    problem: f.problem,
    declaration,
    parameters: {},
    job: f.job("beta"),
    team: f.store().team("beta"),
  });
  expect(pinned.simulatorAuthority).toEqual(binding("beta"));
});

test("legacy single Simulator and real AWS keep unbound jobs, but never adopt bound jobs", async () => {
  const f = fixture();
  const original = f.job("alpha");
  const unit = unitOf(original);
  delete unit.simulatorAuthority;
  const job = { ...original, unit: JSON.stringify(unit) };
  const team = f.store().team("alpha");
  delete required(team.aws).simulatorAuthority;
  f.store().putTeam(team);
  const legacy = {
    ...f.alpha.options,
    simulatorAuthority: undefined,
    simulatorEndpoint: undefined,
  };
  const single = new CloudFormationEngine(root, {
    ...legacy,
    simulatorEndpoint: "http://127.0.0.1:4566",
  });
  const aws = new CloudFormationEngine(root, legacy);
  await single.recover(job);
  await aws.recover(job);
  f.alpha.aws.assumed.length = 0;
  await expect(aws.recover(original)).rejects.toMatchObject({
    kind: "simulator_authority_unavailable",
  });
  await expect(single.recover(original)).rejects.toMatchObject({
    kind: "simulator_authority_unavailable",
  });
  expect(f.alpha.aws.assumed).toEqual([]);
  const direct = new AwsDisruptionAdapter(
    { sts: f.alpha.aws.sts as never, ssm: f.alpha.disruption.ssm },
    legacy.externalId,
  );
  expect(
    await direct.submit({
      target: target(original),
      dispatch: target(original).inject,
      operationKey: "no-fallback",
      assertCurrent: current,
    }),
  ).toMatchObject({ kind: "rejected" });
  expect(f.alpha.aws.assumed).toEqual([]);
  expect(f.alpha.disruption.attempts).toEqual([]);
});

test("authority changes while viewer credentials are issued prevent terminal dispatch", async () => {
  const f = fixture();
  const send = f.beta.aws.sts.send;
  f.beta.aws.sts.send = async (command) => {
    const result = await send(command);
    const team = f.store().team("beta");
    f.store().putTeam({
      ...team,
      aws: { ...required(team.aws), simulatorAuthority: binding("beta", 2) },
    });
    return result;
  };
  await expect(
    f
      .cloud()
      .participantAwsAccess({ kind: "terminal", job: f.job("beta"), assertCurrent: current }),
  ).rejects.toThrow();
  expect(f.beta.calls).toEqual([]);
  expect(f.alpha.aws.assumed).toEqual([]);
});

test("CFN rechecks after STS before a simulated network send", async () => {
  const f = fixture();
  const send = f.beta.aws.sts.send;
  f.beta.aws.sts.send = async (command) => {
    const response = await send(command);
    const team = f.store().team("beta");
    f.store().putTeam({
      ...team,
      aws: { ...required(team.aws), simulatorAuthority: binding("beta", 2) },
    });
    return response;
  };
  await expect(f.cloud().recover(f.job("beta"))).rejects.toMatchObject({
    kind: "simulator_authority_unavailable",
  });
  expect(f.beta.transportCalls).toEqual([]);
  expect(f.alpha.transportCalls).toEqual([]);
});

test("cached CFN credentials cannot skip the authority check on a subsequent send", async () => {
  const f = fixture();
  const job: Job = { ...f.job("beta"), unit: null, status: "PENDING" };
  f.beta.aws.beforeCreate = () => {
    f.engines().delete("beta");
  };
  await expect(
    f.cloud().start(job, (unit) => {
      job.unit = unit;
    }),
  ).rejects.toMatchObject({ kind: "simulator_authority_unavailable" });
  expect(f.beta.transportCalls).toEqual(["CreateStackCommand"]);
  expect(unitOf(job).simulatorAuthority).toEqual(binding("beta"));
  expect(f.alpha.transportCalls).toEqual([]);
});

test.each(["inject", "revert", "observe", "discover"])(
  "%s rechecks removed authority after STS, before SSM",
  async (operation) => {
    const f = fixture();
    const send = f.beta.aws.sts.send;
    f.beta.aws.sts.send = async (command) => {
      const response = await send(command);
      f.engines().delete("beta");
      return response;
    };
    const adapter = f.cloud().disruptionAdapter();
    const t = target(f.job("beta"));
    if (operation === "observe")
      expect(await adapter.observe({ target: t, operationId: "command-1" })).toMatchObject({
        kind: "unknown",
      });
    else if (operation === "discover")
      expect(
        await adapter.discover({ target: t, dispatch: t.inject, operationKey: "same", sentAt: 0 }),
      ).toMatchObject({ kind: "unknown" });
    else
      expect(
        await adapter.submit({
          target: t,
          dispatch: operation === "inject" ? t.inject : t.revert,
          operationKey: "same",
          assertCurrent: current,
        }),
      ).toMatchObject({ kind: "rejected" });
    expect(f.beta.disruption.attempts).toEqual([]);
    expect(f.alpha.aws.assumed).toEqual([]);
    await f.cloud().recover(f.job("alpha"));
  },
);

test("a directly bound adapter without SSM transport refuses before STS instead of using real AWS", async () => {
  const f = fixture();
  const t = target(f.job("beta"));
  const adapter = new AwsDisruptionAdapter(
    { sts: f.beta.aws.sts as never },
    f.beta.options.externalId,
    undefined,
    undefined,
    binding("beta"),
  );
  expect(
    await adapter.submit({
      target: t,
      dispatch: t.inject,
      operationKey: "no-fallback",
      assertCurrent: current,
    }),
  ).toMatchObject({ kind: "rejected" });
  expect(await adapter.observe({ target: t, operationId: "command-1" })).toMatchObject({
    kind: "unknown",
  });
  expect(
    await adapter.discover({ target: t, dispatch: t.inject, operationKey: "same", sentAt: 0 }),
  ).toMatchObject({ kind: "unknown" });
  expect(f.beta.aws.assumed).toEqual([]);
  expect(f.alpha.aws.assumed).toEqual([]);
});

test("routing refuses a leaf engine without the shared live resolver before transport", async () => {
  const f = fixture();
  f.engines().set("beta", new CloudFormationEngine(root, f.beta.options));
  await expect(f.cloud().recover(f.job("beta"))).rejects.toMatchObject({
    kind: "simulator_authority_unavailable",
  });
  const t = target(f.job("beta"));
  expect(
    await f.cloud().disruptionAdapter().observe({ target: t, operationId: "command-1" }),
  ).toMatchObject({ kind: "unknown" });
  expect(f.alpha.aws.assumed).toEqual([]);
  expect(f.beta.aws.assumed).toEqual([]);
  expect(f.beta.disruption.attempts).toEqual([]);
});
