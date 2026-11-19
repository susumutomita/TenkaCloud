import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { id } from "../auth";
import { AwsDisruptionAdapter } from "../aws-disruption-adapter";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import type { DisruptionTarget } from "../disruption-model";
import type { Job } from "../model";
import { HostingService } from "../service";
import type { SimulatorBattle } from "../simulator-battle";
import { HostStore } from "../store";
import { uptimeGeneration } from "../uptime";
import { DisruptionAws } from "./disruption-fixture";
import { FakeAws } from "./fake-aws";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fakeBattle() {
  const calls: string[] = [];
  const battle: SimulatorBattle = {
    clockDomain: "tc-clock",
    probe(job) {
      if (job.status !== "COMPLETE") return undefined;
      calls.push(`probe:${job.jobId}`);
      return async () => ({ ok: true, status: 200, responseTimeMs: 1 });
    },
    async seal(job) {
      calls.push(`seal:${job.jobId}`);
    },
    async terminal(input) {
      calls.push(`terminal:${input.instanceId}:${input.credentials.accessKeyId}`);
      return {
        code: "c".repeat(64),
        terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  return { battle, calls };
}

function host(
  battle?: SimulatorBattle,
  console?: Pick<
    ConstructorParameters<typeof CloudFormationEngine>[1],
    "simulatorConsole" | "simulatorInstanceConsole"
  >,
) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-simulator-battle-"));
  const store = new HostStore(new Database(":memory:"));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const aws = new FakeAws();
  const disruptionAws = new DisruptionAws();
  const cloud = new CloudFormationEngine(root, {
    simulatorEndpoint: "http://127.0.0.1:4566",
    simulatorServices: ["sts", "iam", "cloudformation", "ssm", "lambda"],
    ...(battle ? { simulatorBattle: battle } : {}),
    ...console,
    region: "ap-northeast-1",
    externalId: "fixture-external-id-0123456789",
    operatorAccountId: async () => "999999999999",
    sts: aws.sts as never,
    cloudFormation: aws.cloudFormation as never,
    ssm: disruptionAws.ssm as never,
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  const engine = new CompetitionEngine(root, directory, false, cloud);
  const service = new HostingService(store, engine, HOST_KEY);
  return { aws, cloud, engine, service, store };
}

test("Hello World Battle is offered in simulator mode only with a configured Battle runtime", () => {
  expect(
    host()
      .cloud.catalog()
      .map((problem) => problem.problemId),
  ).not.toContain("hello-world-battle");
  expect(
    host(fakeBattle().battle)
      .cloud.catalog()
      .map((problem) => problem.problemId),
  ).toContain("hello-world-battle");
});

test.each(["event", "environment", "seal-failure"] as const)(
  "the Battle runtime seals through %s teardown and offers a gated terminal",
  async (teardown) => {
    const { battle, calls } = fakeBattle();
    const fixture = host(battle);
    const seal = battle.seal;
    battle.seal = async (target) => {
      expect(target.status).toBe("DELETING");
      expect(fixture.aws.deleted).toHaveLength(0);
      await seal(target);
      if (teardown === "seal-failure") throw new Error("seal unavailable");
    };
    const problem = fixture.cloud
      .catalog()
      .find((entry) => entry.problemId === "hello-world-battle");
    if (!problem) throw new Error("Battle missing from the simulator catalog");
    const now = Date.now();
    const eventId = id();
    const teamId = id();
    fixture.store.putEvent({
      eventId,
      name: "Battle",
      status: "READY",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: Math.floor(now / 1000) + 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [problem],
    });
    fixture.store.putTeam({
      teamId,
      eventId,
      internalSlug: "alpha",
      displayName: "Alpha",
      loginKey: "battle-team-key",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId: "000000000000", roleName: "TenkaCloud-SimulatorDeploy-Role" },
    });
    const jobId = id();
    const job: Job = {
      jobId,
      eventId,
      teamId,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      deployedAt: now - 1000,
      unit: JSON.stringify({
        kind: "cloudformation",
        accountId: "000000000000",
        roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
        region: "ap-northeast-1",
        stackName: "tc-hello-world-battle-alpha",
        stackId: fixture.aws.seedStack("tc-hello-world-battle-alpha", [
          { Key: "tenkacloud:job", Value: jobId },
        ]).stackId,
        outputs: {
          ParticipantViewerRoleArn: "arn:aws:iam::000000000000:role/tc-hello-world-battle-viewer",
          Ec2HostHint: "ec2-10-0-1-5.ap-northeast-1.compute.simulator.invalid",
          InstanceId: "i-0123456789abcdef0",
        },
      }),
    };
    fixture.store.putJob(job);
    const view = await fixture.service.participant(
      apiRequest({ method: "GET", path: "/portal/me", token: "battle-team-key" }),
    );
    const listed = (
      view.body as { problems: { problemId: string; accessCapabilities?: string[] }[] }
    ).problems[0];
    expect(listed?.accessCapabilities).toEqual(["guest-terminal", "cli-credentials"]);

    // The job's own probe replaces the public HTTP probe.
    expect(fixture.engine.uptimeProbe(job)).toBeDefined();
    expect(fixture.engine.requiresGuestReadiness(job)).toBe(true);
    expect(fixture.engine.requiresGuestReadiness({ ...job, unit: null })).toBe(true);
    expect(calls).toContain(`probe:${job.jobId}`);

    const terminal = () =>
      fixture.service.participant(
        apiRequest({
          method: "GET",
          path: "/portal/me/guest-terminal",
          token: "battle-team-key",
          query: new URLSearchParams({ jobId: job.jobId }),
        }),
      );
    // Before the guest has answered once, no code is issued (a failed start keeps it busy).
    await expect(terminal()).rejects.toMatchObject({ status: 409, kind: "guest_not_ready" });
    expect(calls.some((call) => call.startsWith("terminal:"))).toBe(false);
    const state = fixture.store.uptimeState(eventId, teamId, job.problemId);
    fixture.store.putUptimeState(eventId, teamId, job.problemId, {
      ...state,
      generation: uptimeGeneration(job),
      readyAt: now,
    });
    const issued = await terminal();
    expect(issued.body).toMatchObject({
      code: "c".repeat(64),
      terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
    });
    expect(calls.at(-1)).toMatch(/^terminal:i-0123456789abcdef0:/u);

    const token = await bootstrapOrganizer(fixture.service, HOST_KEY);
    const path =
      teardown === "event" ? `/events/${eventId}` : `/events/${eventId}/deployments/${jobId}`;
    expect(
      (await fixture.service.admin(apiRequest({ method: "DELETE", path, token }))).status,
    ).toBe(202);
    await fixture.service.drain();
    expect(fixture.store.jobs(eventId)[0]?.status).toBe("DELETED");
    expect(calls.at(-1)).toBe(`seal:${job.jobId}`);
    expect(fixture.aws.deleted).toHaveLength(1);
  },
);

test("Battle disruptions assume the separate command role, never the deploy role", async () => {
  const roles: string[] = [];
  const disruption = new DisruptionAws();
  const sts = {
    send: async (command: AssumeRoleCommand) => {
      roles.push(command.input.RoleArn ?? "");
      return disruption.sts.send(command);
    },
  };
  const adapter = new AwsDisruptionAdapter(
    { sts: sts as never, ssm: disruption.ssm as never },
    "fixture-required-external-id",
    undefined,
    "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorCommand-Role",
  );
  const dispatch: DisruptionTarget["inject"] = {
    kind: "ssm-run-command",
    target: "i-0123456789abcdef0",
    documentName: "AWS-RunShellScript",
    params: { commands: ["systemctl stop nginx || true"] },
  };
  const target: DisruptionTarget = {
    jobId: "job-1",
    eventId: "event-1",
    teamId: "team-1",
    stackId: "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/tc-hello-world-battle/1",
    unitHash: "a".repeat(64),
    deployedAt: 1,
    accountId: "000000000000",
    region: "ap-northeast-1",
    roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
    resources: [],
    inject: dispatch,
    revert: dispatch,
    afterSeconds: 600,
  };
  const submitted = await adapter.submit({
    target,
    dispatch,
    operationKey: "op-1",
    assertCurrent: () => undefined,
  });
  expect(submitted.kind).not.toBe("rejected");
  expect(roles).toEqual(["arn:aws:iam::000000000000:role/TenkaCloud-SimulatorCommand-Role"]);
});

/** Host authorization only: fake AWS/Battle adapters do not attest VM isolation. */
function twoTeamHost() {
  const { battle, calls } = fakeBattle();
  const fixture = host(battle);
  const problem = fixture.cloud.catalog().find((entry) => entry.problemId === "hello-world-battle");
  if (!problem) throw new Error("Battle missing from the simulator catalog");
  const now = Date.now();
  const eventId = id();
  fixture.store.putEvent({
    eventId,
    name: "Two-team boundary",
    status: "READY",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    startsAt: new Date(now - 1000).toISOString(),
    expiresAt: Math.floor(now / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem],
  });
  const teams = ["alpha", "beta"].map((slug, index) => {
    const teamId = id();
    const jobId = id();
    const loginKey = `fixture-${slug}-key`;
    const instanceId = `i-${String(index + 1).padStart(17, "0")}`;
    fixture.store.putTeam({
      teamId,
      eventId,
      internalSlug: slug,
      displayName: slug,
      loginKey,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId: "000000000000", roleName: "TenkaCloud-SimulatorDeploy-Role" },
    });
    const stackName = `tc-battle-${slug}`;
    const stack = fixture.aws.seedStack(stackName, [{ Key: "tenkacloud:job", Value: jobId }]);
    const job: Job = {
      jobId,
      eventId,
      teamId,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      deployedAt: now - 1000,
      unit: JSON.stringify({
        kind: "cloudformation",
        accountId: "000000000000",
        roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
        region: "ap-northeast-1",
        stackName,
        stackId: stack.stackId,
        outputs: {
          ParticipantViewerRoleArn: `arn:aws:iam::000000000000:role/tc-${slug}-viewer`,
          Ec2HostHint: `ec2-10-0-1-${String(index + 5)}.ap-northeast-1.compute.simulator.invalid`,
          InstanceId: instanceId,
        },
      }),
    };
    fixture.store.putJob(job);
    const ready = () =>
      fixture.store.putUptimeState(eventId, teamId, job.problemId, {
        ...fixture.store.uptimeState(eventId, teamId, job.problemId),
        generation: uptimeGeneration(job),
        readyAt: now,
      });
    const terminal = (target = jobId) =>
      fixture.service.participant(
        apiRequest({
          method: "GET",
          path: "/portal/me/guest-terminal",
          token: loginKey,
          query: new URLSearchParams({ jobId: target }),
        }),
      );
    return { job, instanceId, stack, ready, terminal };
  });
  const [alpha, beta] = teams;
  if (!alpha || !beta) throw new Error("Expected two fixture teams");
  return { ...fixture, calls, eventId, alpha, beta };
}

test("two teams sharing an account cannot request each other's Battle terminal", async () => {
  const f = twoTeamHost();
  f.alpha.ready();
  f.beta.ready();
  for (const [caller, other] of [
    [f.alpha, f.beta],
    [f.beta, f.alpha],
  ] as const) {
    await expect(caller.terminal(other.job.jobId)).rejects.toMatchObject({
      status: 403,
      kind: "unauthorized",
    });
  }
  expect(f.calls).toEqual([]);
  expect(f.aws.assumed).toEqual([]);
  await f.alpha.terminal();
  await f.beta.terminal();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toStartWith(`terminal:${f.alpha.instanceId}:`);
  expect(f.calls[1]).toStartWith(`terminal:${f.beta.instanceId}:`);
});

test("one team's readiness cannot unlock the other team's Battle terminal", async () => {
  const f = twoTeamHost();
  f.alpha.ready();
  await expect(f.beta.terminal()).rejects.toMatchObject({ status: 409, kind: "guest_not_ready" });
  expect(f.calls).toEqual([]);
  expect(f.aws.assumed).toEqual([]);
  await f.alpha.terminal();
  expect(f.calls).toHaveLength(1);
});

test("tearing down one team's Battle seals only its job and keeps the other accessible", async () => {
  const f = twoTeamHost();
  f.alpha.ready();
  f.beta.ready();
  const token = await bootstrapOrganizer(f.service, HOST_KEY);
  await f.service.admin(
    apiRequest({
      method: "DELETE",
      path: `/events/${f.eventId}/deployments/${f.alpha.job.jobId}`,
      token,
    }),
  );
  await f.service.drain();
  expect(f.store.jobs(f.eventId).find((job) => job.jobId === f.alpha.job.jobId)?.status).toBe(
    "DELETED",
  );
  expect(f.store.jobs(f.eventId).find((job) => job.jobId === f.beta.job.jobId)?.status).toBe(
    "COMPLETE",
  );
  expect(f.calls).toEqual([`seal:${f.alpha.job.jobId}`]);
  expect(f.aws.deleted).toEqual([f.alpha.stack.stackId]);
  expect(f.alpha.stack.status).toBe("DELETE_COMPLETE");
  expect(f.beta.stack.status).toBe("CREATE_COMPLETE");
  await expect(f.alpha.terminal()).rejects.toMatchObject({ status: 409, kind: "not_ready" });
  await f.beta.terminal();
  expect(f.calls.at(-1)).toStartWith(`terminal:${f.beta.instanceId}:`);
});

test.each([
  { instanceConsole: true, capabilities: ["console", "cli-credentials"] },
  { instanceConsole: false, capabilities: ["guest-terminal", "cli-credentials"] },
])(
  "Battle console entry follows the Simulator's server console support: $instanceConsole",
  async ({ instanceConsole, capabilities }) => {
    const issued: unknown[] = [];
    const { battle } = fakeBattle();
    const fixture = host(battle, {
      simulatorInstanceConsole: instanceConsole,
      simulatorConsole: async (input) => {
        issued.push(input);
        return "http://127.0.0.1:4566/_simulator/login#handoff=synthetic";
      },
    });
    const problem = fixture.cloud
      .catalog()
      .find((entry) => entry.problemId === "hello-world-battle");
    if (!problem) throw new Error("Battle missing from the simulator catalog");
    const now = Date.now();
    const eventId = id();
    const teamId = id();
    fixture.store.putEvent({
      eventId,
      name: "Battle",
      status: "READY",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: Math.floor(now / 1000) + 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [problem],
    });
    fixture.store.putTeam({
      teamId,
      eventId,
      internalSlug: "alpha",
      displayName: "Alpha",
      loginKey: "battle-team-key",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId: "000000000000", roleName: "TenkaCloud-SimulatorDeploy-Role" },
    });
    const jobId = id();
    fixture.store.putJob({
      jobId,
      eventId,
      teamId,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      deployedAt: now - 1000,
      unit: JSON.stringify({
        kind: "cloudformation",
        accountId: "000000000000",
        roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
        region: "ap-northeast-1",
        stackName: "tc-hello-world-battle-alpha",
        stackId: fixture.aws.seedStack("tc-hello-world-battle-alpha", [
          { Key: "tenkacloud:job", Value: jobId },
        ]).stackId,
        outputs: {
          ParticipantViewerRoleArn: "arn:aws:iam::000000000000:role/tc-hello-world-battle-viewer",
          InstanceId: "i-0123456789abcdef0",
        },
      }),
    });
    const view = await fixture.service.participant(
      apiRequest({ method: "GET", path: "/portal/me", token: "battle-team-key" }),
    );
    const listed = (view.body as { problems: { accessCapabilities?: string[] }[] }).problems[0];
    expect(listed?.accessCapabilities).toEqual([...capabilities]);
    // Neither endpoint is registered and scoring has not succeeded, yet the console is issued.
    const response = fixture.service.participant(
      apiRequest({
        method: "GET",
        path: "/portal/me/console-signin-url",
        token: "battle-team-key",
        query: new URLSearchParams({ jobId }),
      }),
    );
    if (instanceConsole) {
      expect((await response).body).toEqual({
        loginUrl: "http://127.0.0.1:4566/_simulator/login#handoff=synthetic",
      });
      expect(issued).toMatchObject([{ instanceId: "i-0123456789abcdef0" }]);
    } else {
      await expect(response).rejects.toMatchObject({ status: 409 });
      expect(issued).toHaveLength(0);
    }
  },
);
