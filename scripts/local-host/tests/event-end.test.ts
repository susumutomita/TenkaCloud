import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_ORGANIZER, HOST_KEY, PROBLEM_ID, setupMatch } from "../bench/state-setup";
import { CompetitionEngine } from "../competition-engine";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), "tenka-event-end-"));
  const clock = { now: Date.parse("2026-10-03T00:00:00Z") };
  const store = new HostStore(new Database(join(data, "host.sqlite")));
  const service = new HostingService(
    store,
    new CompetitionEngine(root, data),
    HOST_KEY,
    () => clock.now,
  );
  const event = await setupMatch(service, 2);
  const other = await setupMatch(service, 2);
  const adminHost = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: data,
    service,
  });
  const portalHost = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: data,
    service,
  });
  cleanups.push(async () => {
    await adminHost.close();
    await portalHost.close();
    await service.drain();
    store.close();
    rmSync(data, { recursive: true, force: true });
  });
  async function request(
    origin: string,
    path: string,
    token: string,
    method: string,
    body?: unknown,
  ) {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const login = await request(adminHost.origin, "/host/login", "", "POST", BENCH_ORGANIZER);
  const token = String(login.body.idToken);
  const admin = (suffix: string, method = "POST", body?: unknown, credential = token) =>
    request(adminHost.origin, `/events/${event.eventId}${suffix}`, credential, method, body);
  const first = event.teams[0];
  if (!first) throw new Error("Expected the first team.");
  const participant = (path: string, method = "GET", body?: unknown) =>
    request(portalHost.origin, path, first.teamLoginKey, method, body);
  return { store, clock, event, other, first, admin, participant };
}

function match(store: HostStore, eventId: string) {
  return JSON.parse(store.coordination(eventId, PROBLEM_ID) ?? "null") as {
    state: { nowMs: number };
    scores: Record<string, number>;
  };
}

test("local Battle end uses server time, retains results and rejects client-time backdating", async () => {
  const f = await fixture();
  f.clock.now += 1_000;
  const projection = await f.participant("/portal/me/coordination/projection");
  const contracts = (
    projection.body.projection as { myContracts: { id: string; allowedMethods: string[] }[] }
  ).myContracts;
  const contract = contracts.find((item) => item.allowedMethods.includes("leak"));
  if (!contract) throw new Error("Expected a leakable contract.");
  expect(
    (
      await f.participant("/portal/me/coordination/op", "POST", {
        op: { kind: "leak", contractId: contract.id },
      })
    ).status,
  ).toBe(200);
  expect(f.store.team(f.first.teamId).score).toBeGreaterThan(0);

  // This was the schedule button's request: even 1 ms of transit makes its timestamp past.
  const clientNow = new Date(f.clock.now).toISOString();
  f.clock.now += 1;
  const rejected = await f.admin("/schedule", "PATCH", { endsAt: clientNow });
  expect(rejected.status).toBe(409);
  expect(rejected.body.message).toBe(
    "A running Battle cannot end in the past. Use End Event to stop now.",
  );
  expect(f.store.event(f.event.eventId).endsAt).toBeUndefined();
  expect((await f.admin("/end", "POST", {}, f.first.teamLoginKey)).status).toBe(401);

  const unrelated = {
    event: f.store.event(f.other.eventId),
    teams: f.store.teams(f.other.eventId),
    match: f.store.coordination(f.other.eventId, PROBLEM_ID),
  };
  f.clock.now += 60_000;
  const cutoff = new Date(f.clock.now).toISOString();
  const [ended, concurrentRetry] = await Promise.all([f.admin("/end"), f.admin("/end")]);
  expect(ended).toEqual({ status: 200, body: { endsAt: cutoff, updatedDeployments: 2 } });
  expect(concurrentRetry).toEqual(ended);
  expect(f.store.event(f.event.eventId).status).toBe("ENDED");
  expect(match(f.store, f.event.eventId).state.nowMs).toBe(61_001);
  const finalTeams = f.store.teams(f.event.eventId);
  const finalMatch = match(f.store, f.event.eventId);
  expect(f.store.jobs(f.event.eventId).every((job) => job.status === "COMPLETE")).toBe(true);

  f.clock.now += 60_000;
  expect(await f.admin("/end")).toEqual(ended);
  const blocked = await f.participant("/portal/me/coordination/op", "POST", {
    op: { kind: "leak", contractId: contract.id },
  });
  expect(blocked.status).toBe(422);
  expect(blocked.body.error).toBe("event_ended");
  expect((await f.participant("/portal/me/coordination/projection")).status).toBe(200);
  expect((await f.participant("/portal/leaderboard")).status).toBe(200);
  expect(f.store.teams(f.event.eventId)).toEqual(finalTeams);
  expect(match(f.store, f.event.eventId).state).toEqual(finalMatch.state);
  expect(match(f.store, f.event.eventId).scores).toEqual(finalMatch.scores);
  expect(f.store.event(f.other.eventId)).toEqual(unrelated.event);
  expect(f.store.teams(f.other.eventId)).toEqual(unrelated.teams);
  expect(f.store.coordination(f.other.eventId, PROBLEM_ID)).toBe(unrelated.match);
});

test("a future scheduled end remains supported and end retries retain its scoring cutoff", async () => {
  const f = await fixture();
  const cutoff = new Date(f.clock.now + 60_000).toISOString();
  expect((await f.admin("/schedule", "PATCH", { endsAt: cutoff })).status).toBe(200);
  expect(f.store.event(f.event.eventId).status).toBe("READY");
  f.clock.now += 90_000;
  const ended = await f.admin("/end");
  expect(ended).toEqual({ status: 200, body: { endsAt: cutoff, updatedDeployments: 2 } });
  expect(f.store.event(f.event.eventId).status).toBe("ENDED");
  expect(match(f.store, f.event.eventId).state.nowMs).toBe(60_000);
  const teams = f.store.teams(f.event.eventId);
  f.clock.now += 30_000;
  expect(await f.admin("/end")).toEqual(ended);
  expect(f.store.teams(f.event.eventId)).toEqual(teams);
  expect((await f.admin("/schedule", "PATCH", { startNow: true })).status).toBe(409);
});

test("an ended native Battle archives without resource teardown and retains its results", async () => {
  const f = await fixture();
  expect((await f.admin("/archive")).status).toBe(409);
  await f.admin("/end");
  const teams = f.store.teams(f.event.eventId);
  const jobs = f.store.jobs(f.event.eventId);
  const state = f.store.coordination(f.event.eventId, PROBLEM_ID);
  expect(jobs.every((job) => job.unit !== null)).toBe(true);
  expect((await f.admin("/archive", "POST", {}, f.first.teamLoginKey)).status).toBe(401);
  expect((await f.admin("/archive")).status).toBe(200);
  expect(f.store.event(f.event.eventId).status).toBe("ARCHIVED");
  expect(f.store.teams(f.event.eventId)).toEqual(teams);
  expect(f.store.jobs(f.event.eventId)).toEqual(jobs);
  expect(f.store.coordination(f.event.eventId, PROBLEM_ID)).toBe(state);
  expect(f.store.event(f.other.eventId).status).toBe("READY");
  expect(
    (await f.participant("/portal/me/coordination/op", "POST", { op: { kind: "noop" } })).status,
  ).toBe(422);
});

test("archive still requires teardown for owned Docker and historical cloud resources", async () => {
  const f = await fixture();
  await f.admin("/end");
  const job = f.store.jobs(f.event.eventId)[0];
  if (!job) throw new Error("Expected a prepared environment.");
  const originalDefinition = job.definition;
  for (const definition of ["{}", JSON.stringify({ kind: "cloudformation" })]) {
    job.definition = definition;
    f.store.putJob(job);
    const rejected = await f.admin("/archive");
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("environments_remain");
    expect(f.store.event(f.event.eventId).status).toBe("ENDED");
    expect(f.store.job(job.jobId).unit).toBe(job.unit);
  }
  job.definition = originalDefinition;
  f.store.putJob(job);
});
