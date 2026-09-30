import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine, cloudFormationCatalog } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { DockerHostingEngine } from "../docker-engine";
import type { Context, ScoreEvent } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { FakeAws, fakeFlag } from "./fake-aws";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const START = Date.parse("2026-09-30T00:00:00.000Z");
const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const helloWorld = JSON.parse(
  readFileSync(join(root, "problems/challenges/hello-world/metadata.json"), "utf8"),
) as {
  name: string;
  instructions: string;
  scoring: { hints: { id: string; content: string }[] };
  i18n: { en: { name: string; instructions: string; hints: { id: string; content: string }[] } };
};

interface Created {
  eventId: string;
  teams: { teamId: string; internalSlug: string; teamLoginKey: string }[];
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

async function host(withAws = true) {
  const data = mkdtempSync(join(tmpdir(), "tenka-cloud-play-"));
  directories.push(data);
  const store = new HostStore(new Database(join(data, "host.sqlite")));
  stores.push(store);
  const aws = new FakeAws();
  let clock = START;
  const cloud = new CloudFormationEngine(root, {
    region: "ap-northeast-1",
    externalId: "host-external-id-0123456789",
    operatorAccountId: async () => "999999999999",
    sts: aws.sts as never,
    cloudFormation: aws.cloudFormation as never,
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 60_000,
  });
  const engine = new CompetitionEngine(root, data, true, withAws ? cloud : undefined);
  const service = new HostingService(store, engine, HOST_KEY, () => clock);
  const login = await service.admin(
    apiRequest({ method: "POST", path: "/host/login", token: "", body: { key: HOST_KEY } }),
  );
  const token = (login.body as { idToken: string }).idToken;
  return {
    store,
    aws,
    service,
    engine,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    admin: (method: string, path: string, body: Record<string, unknown> = {}) =>
      service.admin(apiRequest({ method, path, token, body })),
    as: (team: Created["teams"][number]) => ({
      get: async (path: string) =>
        (await service.participant(apiRequest({ method: "GET", path, token: team.teamLoginKey })))
          .body as Record<string, unknown>,
      post: (path: string, body: Record<string, unknown> = {}) =>
        service.participant(apiRequest({ method: "POST", path, token: team.teamLoginKey, body })),
    }),
  };
}

type Host = Awaited<ReturnType<typeof host>>;

function stackName(fixture: Host, teamSlug: string): string {
  const name = fixture.aws.created.find((input) =>
    String(input.StackName).startsWith(`tc-hello-world-${teamSlug}-`),
  )?.StackName;
  if (!name) throw new Error(`Expected a stack for ${teamSlug}.`);
  return name;
}

/** Battle plus hello-world for two teams with their own AWS accounts, deployed and started. */
async function startedEvent(fixture: Host): Promise<Created> {
  const created = await fixture.admin("POST", "/events", {
    name: "cloud and battle",
    teams: [
      { internalSlug: "alpha", awsAccountId: "111111111111" },
      { internalSlug: "beta", awsAccountId: "222222222222" },
    ],
    problems: [{ problemId: "ac26-crypto-battle" }, { problemId: "hello-world" }],
  });
  expect(created.status).toBe(201);
  const event = created.body as Created;
  expect((await fixture.admin("POST", `/events/${event.eventId}/deploy`)).status).toBe(202);
  await fixture.service.drain();
  expect(fixture.store.event(event.eventId).status).toBe("READY");
  await fixture.admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true });
  return event;
}

function teams(event: Created) {
  return { alpha: required(event.teams[0]), beta: required(event.teams[1]) };
}

function submit(fixture: Host, team: Created["teams"][number], flag: string) {
  return fixture.as(team).post("/portal/me/submit-flag", { problemId: "hello-world", flag });
}

function problem(me: Record<string, unknown>, problemId: string): Record<string, unknown> {
  return required(
    (me.problems as Record<string, unknown>[]).find((each) => each.problemId === problemId),
  );
}

test("a mixed Battle and hello-world event deploys every team and shows the stack without its flag", async () => {
  const fixture = await host();
  const event = await startedEvent(fixture);
  const { alpha } = teams(event);

  const jobs = fixture.store.jobs(event.eventId);
  expect(jobs.map((job) => `${job.problemId}:${job.status}`).sort()).toEqual([
    "ac26-crypto-battle:COMPLETE",
    "ac26-crypto-battle:COMPLETE",
    "hello-world:COMPLETE",
    "hello-world:COMPLETE",
  ]);
  expect(fixture.aws.created.map((input) => input.StackName).sort()).toEqual(
    [stackName(fixture, "alpha"), stackName(fixture, "beta")].sort(),
  );

  const me = await fixture.as(alpha).get("/portal/me");
  expect((me.problems as { problemId: string }[]).map((each) => each.problemId)).toEqual([
    "ac26-crypto-battle",
    "hello-world",
  ]);
  const job = required(
    jobs.find((each) => each.teamId === alpha.teamId && each.problemId === "hello-world"),
  );
  const [hint1, hint2] = helloWorld.scoring.hints;
  expect(problem(me, "hello-world")).toEqual({
    jobId: job.jobId,
    problemId: "hello-world",
    name: helloWorld.name,
    instructions: helloWorld.instructions,
    i18n: { en: { name: helloWorld.i18n.en.name, instructions: helloWorld.i18n.en.instructions } },
    region: "ap-northeast-1",
    awsAccountId: "111111111111",
    provider: "aws",
    status: "COMPLETE",
    stackOutputs: { ParameterConsoleUrl: "https://console.example/p" },
    score: 0,
    scoring: {
      kind: "flag",
      points: 100,
      flagSubmitted: false,
      hints: [
        { id: required(hint1).id, penalty: 20, revealed: false },
        { id: required(hint2).id, penalty: 30, revealed: false },
      ],
    },
    deployLog: { cursor: "", entries: [] },
    eventStartsAt: new Date(START).toISOString(),
    expiresAt: fixture.store.event(event.eventId).expiresAt,
  });
  expect(JSON.stringify(me)).not.toContain(fakeFlag(stackName(fixture, "alpha")));
});

test("stack outputs stay hidden until the event starts", async () => {
  const fixture = await host();
  const created = await fixture.admin("POST", "/events", {
    name: "not started",
    teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
    problems: [{ problemId: "hello-world" }],
  });
  const event = created.body as Created;
  await fixture.admin("POST", `/events/${event.eventId}/deploy`);
  await fixture.service.drain();

  const me = await fixture.as(required(event.teams[0])).get("/portal/me");
  expect(problem(me, "hello-world").stackOutputs).toEqual({});
});

test("a correct flag scores once, trimmed, and a second one is already solved", async () => {
  const fixture = await host();
  const event = await startedEvent(fixture);
  const { alpha } = teams(event);

  const first = await submit(fixture, alpha, `  ${fakeFlag(stackName(fixture, "alpha"))}\n`);
  expect(first).toEqual({ status: 200, body: { kind: "ok", scoreDelta: 100, totalScore: 100 } });
  const again = await submit(fixture, alpha, fakeFlag(stackName(fixture, "alpha")));
  expect(again).toEqual({ status: 200, body: { kind: "already_scored", totalScore: 100 } });

  const team = fixture.store.team(alpha.teamId);
  expect(team.score).toBe(100);
  expect(team.completedProblems).toBe(1);
  expect(
    team.scoreEvents.map(({ source, points, result }) => ({ source, points, result })),
  ).toEqual([{ source: "flag", points: 100, result: "ok" }]);
  const me = await fixture.as(alpha).get("/portal/me");
  expect(problem(me, "hello-world")).toMatchObject({
    score: 100,
    lastResult: "ok",
    scoring: { flagSubmitted: true },
  });
  const board = await fixture.as(alpha).get("/portal/leaderboard");
  expect(
    (board.entries as Record<string, unknown>[]).map(({ teamName, score, completedProblems }) => ({
      teamName,
      score,
      completedProblems,
    })),
  ).toEqual([
    { teamName: "alpha", score: 100, completedProblems: 1 },
    { teamName: "beta", score: 0, completedProblems: 0 },
  ]);
});

test("a wrong flag, including another team's, costs the wrong-answer penalty", async () => {
  const fixture = await host();
  const event = await startedEvent(fixture);
  const { alpha } = teams(event);

  expect(await submit(fixture, alpha, "TC{guess}")).toEqual({
    status: 200,
    body: { kind: "wrong", scoreDelta: -5, totalScore: -5, wrongCount: 1 },
  });
  expect(await submit(fixture, alpha, fakeFlag(stackName(fixture, "beta")))).toEqual({
    status: 200,
    body: { kind: "wrong", scoreDelta: -5, totalScore: -10, wrongCount: 2 },
  });
  const team = fixture.store.team(alpha.teamId);
  expect(team.score).toBe(-10);
  expect(team.completedProblems).toBe(0);
  expect(
    team.scoreEvents.map(({ source, points, result }) => ({ source, points, result })),
  ).toEqual([
    { source: "flag-wrong", points: -5, result: "wrong" },
    { source: "flag-wrong", points: -5, result: "wrong" },
  ]);
});

test("a submission is refused until the team's stack is running with its flag output", async () => {
  const fixture = await host();
  fixture.aws.flagOutput = false;
  const created = await fixture.admin("POST", "/events", {
    name: "missing flag",
    teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
    problems: [{ problemId: "hello-world" }],
  });
  const event = created.body as Created;
  await fixture.admin("POST", `/events/${event.eventId}/deploy`);
  await fixture.service.drain();
  const alpha = required(event.teams[0]);
  const job = required(fixture.store.jobs(event.eventId)[0]);
  expect(fixture.store.event(event.eventId).status).toBe("DEPLOYING");
  expect(job.status).toBe("FAILED");
  expect(job.error).toContain("has no ParameterValue flag output");
  await expect(
    fixture.admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(submit(fixture, alpha, "TC{}")).rejects.toMatchObject({ status: 409 });

  const unstarted: Context = {
    event: fixture.store.event(event.eventId),
    team: fixture.store.team(alpha.teamId),
    jobs: [job],
    now: START,
  };
  await expect(
    fixture.engine.submit(unstarted, { problemId: "hello-world", flag: "TC{}" }),
  ).rejects.toMatchObject({ status: 409, kind: "not_deployed" });
  expect(fixture.store.team(alpha.teamId).score).toBe(0);
  expect(fixture.store.team(alpha.teamId).scoreEvents).toEqual([]);
});

test("a hint is charged once and only its own content is revealed", async () => {
  const fixture = await host();
  const event = await startedEvent(fixture);
  const { alpha } = teams(event);
  const [hint1, hint2] = helloWorld.scoring.hints;
  const english = helloWorld.i18n.en.hints.find((each) => each.id === required(hint1).id);
  const reveal = () =>
    fixture.as(alpha).post("/portal/me/problems/hello-world/hints/hint-1/reveal");

  const first = await reveal();
  const revealedAt = new Date(START).toISOString();
  expect(first).toEqual({
    status: 200,
    body: {
      kind: "ok",
      content: required(hint1).content,
      i18n: { en: { content: required(english).content } },
      penaltyApplied: 20,
      totalScore: -20,
      revealedAt,
    },
  });
  fixture.advance(1000);
  expect((await reveal()).body).toEqual({
    kind: "already_revealed",
    content: required(hint1).content,
    i18n: { en: { content: required(english).content } },
    penaltyApplied: 0,
    totalScore: -20,
    revealedAt,
  });
  await expect(
    fixture.as(alpha).post("/portal/me/problems/hello-world/hints/hint-9/reveal"),
  ).rejects.toMatchObject({ status: 404, kind: "unknown_hint" });

  const team = fixture.store.team(alpha.teamId);
  expect(team.score).toBe(-20);
  expect(
    team.scoreEvents.map(({ source, points, hintId }) => ({ source, points, hintId })),
  ).toEqual([{ source: "hint", points: -20, hintId: "hint-1" }]);
  const me = await fixture.as(alpha).get("/portal/me");
  expect((problem(me, "hello-world").scoring as { hints: unknown }).hints).toEqual([
    {
      id: "hint-1",
      penalty: 20,
      revealed: true,
      content: required(hint1).content,
      revealedAt,
      i18n: { en: { content: required(english).content } },
    },
    { id: required(hint2).id, penalty: 30, revealed: false },
  ]);
});

test("Battle points and cloud points add up whichever arrives first", async () => {
  const fixture = await host();
  const event = await startedEvent(fixture);
  const { alpha, beta } = teams(event);
  for (const team of [alpha, beta])
    await fixture.as(team).post("/portal/me/coordination/op", { op: { kind: "ready" } });
  fixture.advance(1);
  const projection = (await fixture.as(alpha).get("/portal/me/coordination/projection"))
    .projection as { myContracts: { id: string; allowedMethods: string[] }[] };
  const contract = required(
    projection.myContracts.find((each) => each.allowedMethods.includes("leak")),
  );
  const battle = await fixture
    .as(alpha)
    .post("/portal/me/coordination/op", { op: { kind: "leak", contractId: contract.id } });
  expect(battle.status).toBe(200);
  const battlePoints = fixture.store.team(alpha.teamId).score;
  expect(battlePoints).toBeGreaterThan(0);

  fixture.advance(1000);
  expect((await submit(fixture, alpha, fakeFlag(stackName(fixture, "alpha")))).body).toEqual({
    kind: "ok",
    scoreDelta: 100,
    totalScore: battlePoints + 100,
  });
  fixture.advance(1000);
  await fixture.as(alpha).post("/portal/me/problems/hello-world/hints/hint-2/reveal");

  const team = fixture.store.team(alpha.teamId);
  expect(team.score).toBe(battlePoints + 70);
  expect(team.scoreEvents.reduce((sum, each) => sum + each.points, 0)).toBe(team.score);
  expect(team.scoreEvents.map((each) => each.source)).toEqual(["hint", "flag", "coordination"]);
  const me = await fixture.as(alpha).get("/portal/me");
  expect(problem(me, "ac26-crypto-battle").score).toBe(battlePoints);
  expect(problem(me, "hello-world").score).toBe(70);
  const board = await fixture.as(beta).get("/portal/leaderboard");
  expect((board.entries as Record<string, unknown>[])[0]).toMatchObject({
    teamId: alpha.teamId,
    score: battlePoints + 70,
    completedProblems: 1,
  });
});

test("a Docker answer keeps the team's Battle and cloud points and cloud solves", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-cloud-combined-"));
  directories.push(data);
  const engine = new CompetitionEngine(root, data);
  const at = (second: number) => new Date(START + second * 1000).toISOString();
  const event = (problemId: string, source: string, points: number, second: number) =>
    ({
      jobId: `${problemId}-job`,
      problemId,
      source,
      points,
      result: points < 0 && source !== "hint" ? "wrong" : "ok",
      occurredAt: at(second),
    }) satisfies ScoreEvent;
  const earlier = [
    event("hello-world", "hint", -20, 3),
    event("hello-world", "flag", 100, 2),
    event("ac26-crypto-battle", "coordination", 30, 1),
  ];
  const problems = [...engine.catalog(), ...cloudFormationCatalog(root)];
  const context: Context = {
    now: START + 10_000,
    event: {
      eventId: "e",
      name: "mixed",
      status: "READY",
      createdAt: at(0),
      updatedAt: at(0),
      startsAt: at(0),
      expiresAt: 0,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems,
    },
    team: {
      teamId: "a",
      eventId: "e",
      internalSlug: "a",
      displayName: "Alpha",
      loginKey: "test-only",
      snapshot: null,
      score: 110,
      completedProblems: 1,
      scoreEvents: earlier,
    },
    jobs: problems.map((each) => ({
      jobId: `${each.problemId}-job`,
      eventId: "e",
      teamId: "a",
      problemId: each.problemId,
      definition: each.definition,
      offset: 0,
      status: "COMPLETE",
      unit: null,
    })),
  };
  const sqlSolve = event("sqli-demo", "flag", 100, 4);
  const docker = spyOn(DockerHostingEngine.prototype, "submit").mockImplementation(
    async (input) => {
      expect(input.event.problems.map((each) => each.problemId)).toEqual(["sqli-demo"]);
      return {
        status: 200,
        body: {},
        snapshot: "SQL snapshot",
        score: 100,
        completedProblems: 1,
        scoreEvents: [sqlSolve],
      };
    },
  );
  try {
    const answer = await engine.submit(context, { problemId: "sqli-demo", flag: "test-only" });
    expect(answer.score).toBe(210);
    expect(answer.completedProblems).toBe(2);
    expect(answer.scoreEvents).toEqual([sqlSolve, ...earlier]);
  } finally {
    docker.mockRestore();
  }
});

test("without --aws-region the host offers no cloud problem and fails an old stack clearly", async () => {
  const fixture = await host();
  const created = await fixture.admin("POST", "/events", {
    name: "cloud then local",
    teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
    problems: [{ problemId: "hello-world" }],
  });
  const event = created.body as Created;
  await fixture.admin("POST", `/events/${event.eventId}/deploy`);
  await fixture.service.drain();

  const data = mkdtempSync(join(tmpdir(), "tenka-no-aws-"));
  directories.push(data);
  const withoutAws = new CompetitionEngine(root, data);
  expect(withoutAws.catalog().map((each) => each.problemId)).toEqual([
    "sqli-demo",
    "ac26-crypto-battle",
  ]);
  await new HostingService(fixture.store, withoutAws, HOST_KEY, () => START).recover();
  const [job] = fixture.store.jobs(event.eventId);
  expect(job?.status).toBe("FAILED");
  expect(job?.error).toBe(
    "This event has AWS problems. Restart the host with --aws-region and AWS credentials.",
  );
  expect(withoutAws.requiresGateway(required(job).definition)).toBe(false);

  await new HostingService(fixture.store, fixture.engine, HOST_KEY, () => START).recover();
  expect(fixture.store.jobs(event.eventId)[0]?.status).toBe("COMPLETE");
});
