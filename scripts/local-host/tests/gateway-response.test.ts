import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id, randomToken } from "../auth";
import { SurfaceGateways } from "../gateways";
import { closeServer, listen, startHttpHost } from "../http";
import type { HostedEvent, Job, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

const changes = [
  "gate",
  "key",
  "end",
  "operation",
  "unit",
  "definition",
  "generation",
  "unchanged",
] as const;
type Change = (typeof changes)[number];
const content = "PRIVATE_EXERCISE_RESPONSE";

async function fixture(partialBody: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-gateway-response-"));
  const store = new HostStore(new Database(join(directory, "host.sqlite")));
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const upstream = createServer((_request, response) => {
    if (partialBody) {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(content.slice(0, 10));
    }
    entered.resolve(undefined);
    void release.promise.then(() => {
      if (!partialBody) response.writeHead(200, { "content-type": "text/html" });
      response.end(partialBody ? content.slice(10) : content);
    });
  });
  const origin = await listen(upstream, "127.0.0.1", 0);
  const now = Date.now();
  const eventId = id(now),
    teamId = id(now),
    jobId = id(now);
  const problem = { problemId: "exercise", name: "Exercise", definition: "fixture" };
  const event: HostedEvent = {
    eventId,
    name: "Gateway response",
    status: "READY",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + 3600,
    startsAt: new Date(now - 1000).toISOString(),
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem, { ...problem, problemId: "gate" }],
    progressionGate: {
      gateProblemId: "gate",
      unlockTargetIds: ["exercise"],
      defaultPolicy: "required",
    },
  };
  const team: Team = {
    teamId,
    eventId,
    internalSlug: "alpha",
    displayName: "Alpha",
    loginKey: randomToken(),
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
  };
  const job: Job = {
    jobId,
    eventId,
    teamId,
    problemId: "exercise",
    definition: problem.definition,
    offset: 1000,
    status: "COMPLETE",
    unit: "original-runtime",
    deployedAt: now,
  };
  store.putEvent(event);
  store.putTeam(team);
  store.putJob(job);
  const engine = new ExerciseFixture((path) => new Database(path));
  engine.surface = () => origin;
  const service = new HostingService(store, engine, randomToken());
  const host = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
  });
  const gateways = new SurfaceGateways("127.0.0.1", service, { start: 0, end: 0 });
  const link = await gateways.link(job, team);
  const handoff = await fetch(link, { redirect: "manual" });
  await handoff.text();
  const cookie = handoff.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Gateway did not issue a browser session.");
  return {
    entered: entered.promise,
    release: () => release.resolve(undefined),
    request: () => fetch(new URL("/", link), { headers: { cookie } }),
    change(change: Change) {
      if (change === "gate") store.setFeatureFlag("challengePrerequisiteGate", true);
      if (change === "key") store.putTeam({ ...team, loginKey: randomToken() });
      if (change === "end") store.putEvent({ ...event, status: "ENDED" });
      if (change === "operation") store.putJob({ ...job, operation: "restart" });
      if (change === "unit") store.putJob({ ...job, unit: "replacement-runtime" });
      if (change === "generation") store.putJob({ ...job, deployedAt: now + 1 });
      if (change === "definition") store.putJob({ ...job, definition: "replacement-definition" });
    },
    async close() {
      release.resolve(undefined);
      await gateways.close();
      await host.close();
      await closeServer(upstream);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const partialBody of [false, true]) {
  test.each([...changes])(
    `gateway rechecks %s while upstream ${partialBody ? "body" : "headers"} are pending`,
    async (change) => {
      const f = await fixture(partialBody);
      try {
        const pending = f.request();
        await f.entered;
        f.change(change);
        f.release();
        const response = await pending;
        const body = await response.text();
        if (change === "unchanged") {
          expect(response.status).toBe(200);
          expect(body).toBe(content);
        } else {
          expect(response.status).toBe(change === "key" ? 401 : 409);
          expect(body).not.toContain(content.slice(0, 10));
          expect(body).not.toContain(content.slice(10));
        }
      } finally {
        await f.close();
      }
    },
  );
}
