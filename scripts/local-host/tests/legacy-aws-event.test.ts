import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "../auth";
import { CompetitionEngine } from "../competition-engine";
import { DockerHostingEngine } from "../docker-engine";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
import type { Context, ScoreEvent } from "../model";
import { startLocalHost } from "../server";
import { HostStore } from "../store";
import { HistoricalCompetitionEngine } from "./historical-competition-fixture";
import { LEGACY_FLAG_STACK, legacyStackProblem, seedLegacyAwsEvent } from "./legacy-aws-fixture";
import { organizerToken } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const RETIRED_AWS =
  "This event contains AWS resources from an older hosting revision. They are not operated by local hosting. Keep their state and use the reviewed cloud or legacy cleanup workflow; no AWS resources were changed.";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function call(origin: string, path: string, token: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a saved CloudFormation event starts, keeps its stack state and refuses every AWS operation", async () => {
  const directory = privateDirectory(mkdtempSync(join(tmpdir(), "tenka-legacy-aws-")));
  directories.push(directory);
  const path = join(directory, "hosting.sqlite");
  persistentKey(join(directory, "host-key"));
  prepareDatabase(path);
  const now = Date.now() - 60_000;
  const seeding = new HostStore(new Database(path));
  const { event, team, jobs } = seedLegacyAwsEvent(seeding, {
    eventId: id(now),
    teamId: id(now),
    now,
    problems: [legacyStackProblem(LEGACY_FLAG_STACK)],
  });
  seeding.close();
  const [job] = jobs;
  if (!job) throw new Error("The legacy event has no job.");

  const host = await startLocalHost(
    root,
    {
      dataDirectory: directory,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: { start: 58000, end: 58039 },
    },
    (dataDirectory) => new CompetitionEngine(root, dataDirectory, false),
    () => undefined,
  );
  try {
    const key = host.organizerKey;
    if (!key) throw new Error("The legacy database did not receive an organizer key.");
    const admin = await organizerToken({ admin: host.admin.origin, key });
    const portal = host.participant.origin;
    const refusal = { error: "aws_not_configured", kind: "aws_not_configured" };

    for (const origin of [host.admin.origin, portal]) {
      const config = await fetch(`${origin}/runtime-config.json`);
      expect(((await config.json()) as { hasAws: unknown }).hasAws).toBe(false);
    }
    const catalog = await call(host.admin.origin, "/host/catalog", admin);
    expect(
      (catalog.body.items as { runtime: string }[]).filter(
        (item) => item.runtime === "cloudformation",
      ),
    ).toEqual([]);

    // Startup adopts nothing from AWS: the job is reported failed and still owns its stack.
    const detail = await call(host.admin.origin, `/events/${event.eventId}`, admin);
    expect(detail.status).toBe(200);
    const deployments = (
      detail.body.deploymentsByProblem as Record<string, Record<string, unknown>[]>
    )["hello-world"];
    expect(deployments).toEqual([
      expect.objectContaining({ jobId: job.jobId, status: "FAILED", error: RETIRED_AWS }),
    ]);

    expect(await call(portal, "/portal/me", team.loginKey)).toEqual({
      status: 503,
      body: { ...refusal, message: RETIRED_AWS },
    });
    // The failed job is not running, so answers and hints stop at the host before any engine.
    for (const [route, body] of [
      ["/portal/me/submit-flag", { problemId: "hello-world", flag: "FLAG{legacy}" }],
      ["/portal/me/problems/hello-world/hints/hint-1/reveal", undefined],
    ] as const)
      expect(await call(portal, route, team.loginKey, "POST", body)).toEqual({
        status: 409,
        body: {
          error: "request_failed",
          kind: "request_failed",
          message: "This team's problem environment is not running.",
        },
      });
    for (const route of ["/portal/me/console-signin-url", "/portal/me/cli-credentials"]) {
      expect(await call(portal, `${route}?jobId=${job.jobId}`, team.loginKey)).toEqual({
        status: 503,
        body: { ...refusal, message: "AWS access is not configured on this host." },
      });
      expect((await call(portal, `${route}?jobId=invalid`, team.loginKey)).body.kind).toBe(
        "invalid_jobid",
      );
      expect((await call(portal, `${route}?jobId=${job.jobId}`, "invalid")).status).toBe(401);
    }

    // An organizer operation is accepted, then fails with the same refusal and changes nothing.
    expect(
      (
        await call(
          host.admin.origin,
          `/events/${event.eventId}/deployments/${job.jobId}`,
          admin,
          "DELETE",
        )
      ).status,
    ).toBe(202);
  } finally {
    await host.stop();
  }
  const reopened = new HostStore(new Database(path));
  try {
    const retained = reopened.job(job.jobId);
    expect(retained).toMatchObject({ status: "FAILED", error: RETIRED_AWS, unit: job.unit });
    expect(reopened.team(team.teamId).aws).toEqual(team.aws);
  } finally {
    reopened.close();
  }
});

test("every runtime operation on a saved CloudFormation job is refused without touching AWS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-legacy-aws-engine-"));
  directories.push(directory);
  const engine = new CompetitionEngine(root, directory, false);
  const store = new HostStore(new Database(":memory:"));
  try {
    const { event, team, jobs } = seedLegacyAwsEvent(store, {
      eventId: id(1),
      teamId: id(1),
      now: Date.now(),
      problems: [legacyStackProblem(LEGACY_FLAG_STACK)],
    });
    const [job] = jobs;
    if (!job) throw new Error("The legacy event has no job.");
    const context = { now: Date.now(), event, team, jobs };
    const refused = { status: 503, kind: "aws_not_configured", message: RETIRED_AWS };
    for (const operation of [
      () => engine.start(job, () => undefined),
      () => engine.recover(job),
      () => engine.pause(job),
      () => engine.resume(job),
      () => engine.stop(job),
      async () => engine.surface(job),
      () => engine.view(context),
      () => engine.submit(context, { problemId: "hello-world", flag: "FLAG{legacy}" }),
      () => engine.hint(context, "hello-world", "hint-1"),
    ])
      await expect(operation()).rejects.toMatchObject(refused);
    expect(engine.requiresGateway(job.definition)).toBe(false);
    expect(engine.catalog().some((entry) => entry.runtime === "cloudformation")).toBe(false);
  } finally {
    store.close();
  }
});

test("a Docker answer keeps the team's Battle and saved cloud points and cloud solves", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-cloud-combined-"));
  directories.push(data);
  const engine = new HistoricalCompetitionEngine(root, data);
  const start = Date.parse("2026-09-30T00:00:00.000Z");
  const at = (second: number) => new Date(start + second * 1000).toISOString();
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
    event("crypto-battle", "coordination", 30, 1),
  ];
  const problems = [
    ...engine
      .catalog()
      .filter((problem) => ["sqli-demo", "crypto-battle"].includes(problem.problemId)),
    legacyStackProblem(LEGACY_FLAG_STACK),
  ];
  const context: Context = {
    now: start + 10_000,
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
    // The saved hello-world floor of 0 keeps its hint debt from going below zero.
    expect(answer.score).toBe(210);
    expect(answer.completedProblems).toBe(2);
    expect(answer.scoreEvents).toEqual([sqlSolve, ...earlier]);
  } finally {
    docker.mockRestore();
  }
});
