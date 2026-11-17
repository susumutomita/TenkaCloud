import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "../auth";
import { apiRequest } from "../bench/state-setup";
import { CompetitionEngine } from "../competition-engine";
import type { HostedEvent, Job, Problem } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { uptimeGeneration } from "../uptime";
import { DisruptionAws, START } from "./disruption-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(simulator = true, triggered = false) {
  const directory = mkdtempSync(join(tmpdir(), "battle-ready-"));
  const store = new HostStore(new Database(":memory:"));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const engine = new CompetitionEngine(
    fileURLToPath(new URL("../../../", import.meta.url)),
    directory,
    false,
  );
  const aws = new DisruptionAws();
  engine.disruptionAdapter = () => aws.adapter();
  engine.requiresGuestReadiness = () => simulator;
  const service = new HostingService(store, engine, "fixture-host-key", () => aws.now);
  const key = store.ensureLocalOrganizerKey().key;
  if (!key) throw new Error("Missing fixture organizer key");
  store.addSession(
    "organizer",
    "refresh",
    START + 3600_000,
    START,
    undefined,
    undefined,
    store.verifyLocalOrganizerKey(key),
  );
  const problem: Problem = {
    problemId: "hello-world-battle",
    name: "Battle",
    runtime: "cloudformation",
    definition: JSON.stringify({
      kind: "cloudformation",
      disruptions: [
        {
          id: "frontend-down",
          name: "Frontend down",
          eventDetailType: "DisruptionFired",
          ...(triggered ? { triggers: [{ kind: "after-deploy", afterMinutes: 0 }] } : {}),
          action: {
            kind: "ssm-run-command",
            targetRef: "InstanceId",
            documentName: "AWS-RunShellScript",
            paramTemplate: { commands: ["systemctl stop nginx"] },
            revert: { afterSeconds: 600, paramTemplate: { commands: ["systemctl start nginx"] } },
          },
        },
      ],
    }),
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Battle",
    status: "READY",
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    startsAt: new Date(START - 1000).toISOString(),
    expiresAt: Math.floor(START / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem],
  };
  store.putEvent(event);
  store.putTeam({
    teamId: "team",
    eventId: event.eventId,
    internalSlug: "alpha",
    displayName: "Alpha",
    loginKey: "team-key",
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
    aws: { accountId: "000000000000", roleName: "deploy" },
  });
  const job: Job = {
    jobId: "job",
    eventId: event.eventId,
    teamId: "team",
    problemId: problem.problemId,
    definition: problem.definition,
    offset: 0,
    status: "COMPLETE",
    deployedAt: START,
    unit: JSON.stringify({
      kind: "cloudformation",
      accountId: "000000000000",
      roleArn: "arn:aws:iam::000000000000:role/deploy",
      region: "ap-northeast-1",
      stackId: "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/battle/1",
      outputs: { InstanceId: "i-0123456789abcdef0" },
    }),
  };
  store.putJob(job);
  const ready = (generation = uptimeGeneration(job)) =>
    store.putUptimeState(event.eventId, job.teamId, job.problemId, {
      ...store.uptimeState(event.eventId, job.teamId, job.problemId),
      generation,
      readyAt: START,
    });
  const fire = (extra: Record<string, unknown> = {}) =>
    service.admin(
      apiRequest({
        method: "POST",
        path: `/events/${event.eventId}/disruptions/fire`,
        token: "organizer",
        body: {
          problemId: problem.problemId,
          disruptionId: "frontend-down",
          scope: "all",
          requestId: "ready-request",
          ...extra,
        },
      }),
    );
  return {
    store,
    service,
    aws,
    event,
    job,
    ready,
    fire,
    rows: () => service.disruptions.store.executions(event.eventId),
  };
}

for (const timing of ["immediate", "scheduled", "recurring"]) {
  test(`Simulator ${timing} disruption requires this generation's initial readiness`, async () => {
    const f = fixture();
    const extra: Record<string, unknown> = { timing };
    if (timing === "scheduled") extra.afterMinutes = 1;
    if (timing === "recurring") Object.assign(extra, { intervalMinutes: 1, maxFires: 2 });
    await expect(f.fire(extra)).rejects.toMatchObject({ status: 409, kind: "guest_not_ready" });
    f.ready("previous-generation");
    await expect(f.fire(extra)).rejects.toMatchObject({ status: 409, kind: "guest_not_ready" });
    expect(f.rows()).toHaveLength(0);
    expect(f.aws.commands).toHaveLength(0);
    f.ready();
    expect((await f.fire(extra)).status).toBe(202);
    f.aws.now += timing === "immediate" ? 0 : 60_000;
    await f.service.disruptions.tick();
    expect(f.aws.commands).toHaveLength(1);
  });
}

test("Simulator queued injection rechecks readiness, while cleanup can still recover", async () => {
  const f = fixture();
  f.ready();
  await f.fire({ timing: "scheduled", afterMinutes: 1 });
  f.ready("previous-generation");
  f.aws.now += 60_000;
  await f.service.disruptions.tick();
  expect(f.rows()[0]?.status).toBe("skipped");
  expect(f.aws.commands).toHaveLength(0);
  f.ready();
  await f.fire({ requestId: "second-request" });
  await f.service.disruptions.tick();
  expect(f.aws.commands).toHaveLength(1);
  f.ready("previous-generation");
  f.aws.now += 600_000;
  await f.service.disruptions.tick();
  await f.service.disruptions.tick();
  expect(f.aws.commands).toHaveLength(2);
});

test("Simulator metadata triggers wait for initial readiness without consuming the trigger", async () => {
  const f = fixture(true, true);
  await f.service.disruptions.tick();
  expect(f.rows()).toHaveLength(0);
  f.ready("previous-generation");
  await f.service.disruptions.tick();
  expect(f.rows()).toHaveLength(0);
  f.ready();
  await f.service.disruptions.tick();
  expect(f.rows()).toHaveLength(1);
  expect(f.aws.commands).toHaveLength(1);
});

test("ordinary AWS disruptions still run without Simulator scoring readiness", async () => {
  const f = fixture(false);
  expect((await f.fire()).status).toBe(202);
  await f.service.disruptions.tick();
  expect(f.aws.commands).toHaveLength(1);
});

test("Simulator injection rechecks readiness after assuming the command role", async () => {
  const f = fixture();
  f.ready();
  await f.fire();
  f.aws.beforeSend = () => f.ready("previous-generation");
  await f.service.disruptions.tick();
  expect(f.aws.commands).toHaveLength(0);
  expect(f.rows()[0]?.status).toBe("failed");
});

test("another team's initial readiness cannot authorize this Simulator deployment", async () => {
  const f = fixture();
  const otherTeam = {
    ...f.store.team(f.job.teamId),
    teamId: id(),
    internalSlug: "beta",
    loginKey: "beta-key",
  };
  f.store.putTeam(otherTeam);
  const otherJob = { ...f.job, jobId: id(), teamId: otherTeam.teamId };
  f.store.putJob(otherJob);
  f.store.putUptimeState(otherJob.eventId, otherJob.teamId, otherJob.problemId, {
    ...f.store.uptimeState(otherJob.eventId, otherJob.teamId, otherJob.problemId),
    generation: uptimeGeneration(otherJob),
    readyAt: START,
  });
  await expect(f.fire({ scope: "team", targetTeamIds: [f.job.teamId] })).rejects.toMatchObject({
    status: 409,
    kind: "guest_not_ready",
  });
  expect(f.rows()).toHaveLength(0);
  expect(f.aws.commands).toHaveLength(0);
});

test("late Simulator readiness does not replay an overdue metadata disruption", async () => {
  const f = fixture(true, true);
  await f.service.disruptions.tick();
  expect(f.rows()).toHaveLength(0);
  f.aws.now += 60_000;
  f.ready();
  await f.service.disruptions.tick();
  expect(f.rows()[0]?.status).toBe("skipped");
  expect(f.aws.commands).toHaveLength(0);
});
