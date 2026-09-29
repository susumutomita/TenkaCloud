import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiRequest,
  type CreatedTeam,
  HOST_KEY,
  PROBLEM_ID,
  setupMatch,
} from "../bench/state-setup";
import { CompetitionEngine } from "../competition-engine";
import { DEFAULT_GATEWAY_PORTS, parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import { type ApiResponse, HostingService } from "../service";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Contract {
  id: string;
  allowedMethods: string[];
  leakPoints: number;
}

function open(path: string): HostStore {
  const store = new HostStore(new Database(path));
  stores.push(store);
  return store;
}

async function startedMatch(teams: number) {
  const data = mkdtempSync(join(tmpdir(), "tenka-coordination-writes-"));
  directories.push(data);
  const path = join(data, "host.sqlite");
  const clock = { now: Date.parse("2026-09-29T00:00:00Z") };
  const store = open(path);
  const engine = new CompetitionEngine(root, data);
  const service = new HostingService(store, engine, HOST_KEY, () => clock.now);
  const created = await setupMatch(service, teams);
  return { data, path, clock, store, engine, service, created };
}

const read = (team: CreatedTeam) =>
  apiRequest({
    method: "GET",
    path: "/portal/me/coordination/projection",
    token: team.teamLoginKey,
  });
const leak = (team: CreatedTeam, contractId: string) =>
  apiRequest({
    method: "POST",
    path: "/portal/me/coordination/op",
    token: team.teamLoginKey,
    body: { op: { kind: "leak", contractId } },
  });
const leakable = (response: ApiResponse) =>
  (
    (response.body as { projection: { myContracts: Contract[] } }).projection.myContracts ?? []
  ).filter((contract) => contract.allowedMethods.includes("leak"));

const savedVersion = (store: HostStore, eventId: string) =>
  (JSON.parse(store.coordination(eventId, PROBLEM_ID) ?? "{}") as { version: number }).version;

function countWrites(store: HostStore) {
  const put = store.putCoordination.bind(store);
  const counter = { writes: 0 };
  store.putCoordination = (...args) => {
    counter.writes += 1;
    put(...args);
  };
  return counter;
}

test("write-behind serves the same match as saving and reloading SQLite on every request", async () => {
  const { data, clock, store, engine, service, created } = await startedMatch(4);
  const referencePath = join(data, "reference.sqlite");
  store.database.exec(`VACUUM INTO '${referencePath}'`);
  const referenceStore = open(referencePath);
  // A fresh service per request loads the row from SQLite; flushing saves every tick.
  const reference = async (request: ReturnType<typeof apiRequest>) => {
    const today = new HostingService(referenceStore, engine, HOST_KEY, () => clock.now);
    const response = await today.participant(request);
    today.flush();
    return response;
  };
  const leaked = new Set<string>();
  const scoreHistory = new Set<string>();
  // 1.7 s does not divide the flush interval, so reads also land between writes.
  for (let step = 1; step <= 600; step += 1) {
    clock.now += 1_700;
    for (const team of created.teams) {
      const projection = await service.participant(read(team));
      expect(projection).toEqual(await reference(read(team)));
      for (const { id } of leakable(projection).filter((contract) => !leaked.has(contract.id))) {
        leaked.add(id);
        const moved = await service.participant(leak(team, id));
        expect(moved).toEqual(await reference(leak(team, id)));
      }
    }
    const scores = created.teams.map((team) => store.team(team.teamId).score);
    expect(scores).toEqual(created.teams.map((team) => referenceStore.team(team.teamId).score));
    scoreHistory.add(scores.join());
  }
  service.flush();
  expect(store.coordination(created.eventId, PROBLEM_ID)).toBe(
    referenceStore.coordination(created.eventId, PROBLEM_ID),
  );
  expect(leaked.size).toBeGreaterThan(4);
  expect(scoreHistory.size).toBeGreaterThan(2);
}, 60_000);

test("reads without score changes write once per interval; a LEAK writes at once", async () => {
  const { clock, store, service, created } = await startedMatch(4);
  const counter = countWrites(store);
  const [first] = created.teams;
  if (!first) throw new Error("Expected a team.");
  const writesAfter = async (reads: number) => {
    counter.writes = 0;
    for (let index = 0; index < reads; index += 1)
      await service.participant(read(created.teams[index % created.teams.length] as CreatedTeam));
    return counter.writes;
  };
  clock.now += 5_000;
  expect(await writesAfter(12)).toBe(1);
  const before = store.team(first.teamId).score;
  const [order] = leakable(await service.participant(read(first)));
  if (!order) throw new Error("Expected an Order to leak.");
  counter.writes = 0;
  expect((await service.participant(leak(first, order.id))).status).toBe(200);
  expect(counter.writes).toBe(1);
  expect(store.team(first.teamId).score - before).toBe(order.leakPoints);
  clock.now += 4_999;
  expect(await writesAfter(12)).toBe(0);
  clock.now += 1;
  expect(await writesAfter(12)).toBe(1);
});

test("End Event, lock and teardown write their tick without waiting for the interval", async () => {
  const { clock, store, service, created } = await startedMatch(2);
  const [first] = created.teams;
  if (!first) throw new Error("Expected a team.");
  const login = await service.admin(
    apiRequest({ method: "POST", path: "/host/login", token: "", body: { key: HOST_KEY } }),
  );
  const token = (login.body as { idToken: string }).idToken;
  const admin = (method: string, action: string) =>
    service.admin(apiRequest({ method, path: `/events/${created.eventId}${action}`, token }));
  clock.now += 5_000;
  await service.participant(read(first));
  const settledAfterRead = async (method: string, action: string) => {
    const before = savedVersion(store, created.eventId);
    clock.now += 1_000;
    await service.participant(read(first));
    expect((await admin(method, action)).status).toBeLessThan(300);
    return savedVersion(store, created.eventId) - before;
  };
  expect(await settledAfterRead("POST", "/lock-scoring")).toBe(2);
  expect(await settledAfterRead("DELETE", "/lock-scoring")).toBe(0);
  expect(await settledAfterRead("POST", "/end")).toBe(2);
  expect(await settledAfterRead("DELETE", "")).toBe(2);
  await service.drain();
});

test("a clean restart resumes from the ticks the shutdown flush wrote", async () => {
  const { path, clock, store, engine, service, created } = await startedMatch(2);
  const [first] = created.teams;
  if (!first) throw new Error("Expected a team.");
  clock.now += 5_000;
  await service.participant(read(first));
  clock.now += 1_000;
  for (const team of created.teams) await service.participant(read(team));
  const shown = await service.participant(read(first));
  const written = savedVersion(store, created.eventId);
  service.flush();
  const flushed = savedVersion(store, created.eventId);
  expect(flushed - written).toBe(3);
  store.close();
  const reopened = open(path);
  const restarted = new HostingService(reopened, engine, HOST_KEY, () => clock.now);
  expect(await restarted.participant(read(first))).toEqual(shown);
  restarted.flush();
  expect(savedVersion(reopened, created.eventId)).toBe(flushed + 1);
});

test("stopping the host writes the reads it held in memory", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-coordination-stop-"));
  directories.push(data);
  const host = await startLocalHost(
    root,
    {
      dataDirectory: data,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: parseGatewayPorts(DEFAULT_GATEWAY_PORTS),
    },
    (directory) => new CompetitionEngine(root, directory),
    () => undefined,
  );
  let eventId = "";
  try {
    const api = async (
      origin: string,
      path: string,
      method: string,
      token: string,
      body?: unknown,
    ) => {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await response.json()) as Record<string, unknown>;
    };
    const admin = (path: string, method: string, token: string, body?: unknown) =>
      api(host.admin.origin, path, method, token, body);
    const token = (await admin("/host/login", "POST", "", { key: host.masterKey }))
      .idToken as string;
    const created = await admin("/events", "POST", token, {
      name: "stop flush",
      teams: [{ internalSlug: "solo" }],
      problems: [{ problemId: PROBLEM_ID }],
    });
    eventId = created.eventId as string;
    const [team] = created.teams as { teamLoginKey: string }[];
    await admin(`/events/${eventId}/deploy`, "POST", token, {});
    while ((await admin(`/events/${eventId}`, "GET", token)).status !== "READY")
      await Bun.sleep(10);
    await admin(`/events/${eventId}/schedule`, "PATCH", token, { startNow: true });
    const participant = (path: string, method: string, body?: unknown) =>
      api(host.participant.origin, path, method, team?.teamLoginKey ?? "", body);
    await participant("/portal/me/coordination/op", "POST", { op: { kind: "ready" } });
    await participant("/portal/me/coordination/projection", "GET");
  } finally {
    await host.stop();
  }
  expect(savedVersion(open(host.databasePath), eventId)).toBe(3);
});
