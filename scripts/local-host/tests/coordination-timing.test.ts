import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_ORGANIZER, HOST_KEY, PROBLEM_ID } from "../bench/state-setup";
import type { HostPlugin } from "../coordination-core";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { HistoricalCompetitionEngine } from "./historical-competition-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const START = Date.parse("2026-10-22T10:00:00Z");
const MINUTE = 60_000;

/** Shows the platform timing a Battle receives, through the participant projection. */
const recorder: HostPlugin = {
  initialState: (ctx) => ({ created: ctx.matchDurationMs ?? null, tick: null }),
  validateOp: () => ({ ok: true }),
  applyOp: (state) => state,
  tickOnRequest: true,
  tick: (state, eventNowMs, timing) => ({
    ...(state as object),
    tick: { eventNowMs, matchDurationMs: timing?.matchDurationMs ?? null },
  }),
  projectForTeam: (state) => state,
};

class RecordingEngine extends HistoricalCompetitionEngine {
  override coordinationPlugin() {
    return recorder;
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), "tenka-coordination-timing-"));
  const clock = { now: START - 5 * MINUTE };
  const store = new HostStore(new Database(join(data, "host.sqlite")));
  const service = new HostingService(
    store,
    new RecordingEngine(root, data),
    HOST_KEY,
    () => clock.now,
  );
  const admin = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: data,
    service,
  });
  const portal = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: data,
    service,
  });
  cleanups.push(async () => {
    await admin.close();
    await portal.close();
    await service.drain();
    store.close();
    rmSync(data, { recursive: true, force: true });
  });
  async function call(origin: string, path: string, token: string, method = "GET", body?: unknown) {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const login = await call(admin.origin, "/host/bootstrap", "", "POST", {
    key: HOST_KEY,
    ...BENCH_ORGANIZER,
  });
  const organizer = String(login.body.idToken);
  const created = await call(admin.origin, "/events", organizer, "POST", {
    name: "timing",
    teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
    problems: [{ problemId: PROBLEM_ID }],
  });
  const event = created.body as { eventId: string; teams: { teamLoginKey: string }[] };
  await call(admin.origin, `/events/${event.eventId}/deploy`, organizer, "POST", {});
  await service.drain();
  const teamKey = String(event.teams[0]?.teamLoginKey);
  return {
    clock,
    schedule: (body: unknown) =>
      call(admin.origin, `/events/${event.eventId}/schedule`, organizer, "PATCH", body),
    lock: (method: "POST" | "DELETE") =>
      call(admin.origin, `/events/${event.eventId}/lock-scoring`, organizer, method, {}),
    projection: async () =>
      (await call(portal.origin, "/portal/me/coordination/projection", teamKey)).body.projection,
  };
}

test("start with a match length sets endsAt from the host clock and rejects every invalid form", async () => {
  const f = await fixture();
  const rejected = [
    { durationMinutes: 10 },
    { startNow: true, durationMinutes: 4 },
    { startNow: true, durationMinutes: 241 },
    { startNow: true, durationMinutes: 10.5 },
    { startNow: true, durationMinutes: "10" },
    { startNow: true, durationMinutes: 10, startsAt: "2026-10-22T11:00:00Z" },
    { startNow: true, durationMinutes: 10, endsAt: "2026-10-22T11:00:00Z" },
  ];
  for (const body of rejected) expect((await f.schedule(body)).status).toBe(400);
  f.clock.now = START;
  expect(await f.schedule({ startNow: true, durationMinutes: 10 })).toEqual({
    status: 200,
    body: {
      startsAt: "2026-10-22T10:00:00.000Z",
      endsAt: "2026-10-22T10:10:00.000Z",
      updatedDeployments: 2,
    },
  });
});

test("a Battle receives the match length at creation and on every tick, net of pauses", async () => {
  const f = await fixture();
  f.clock.now = START;
  expect((await f.schedule({ startNow: true, durationMinutes: 10 })).status).toBe(200);

  f.clock.now = START + MINUTE;
  expect(await f.projection()).toEqual({
    created: 10 * MINUTE,
    tick: { eventNowMs: MINUTE, matchDurationMs: 10 * MINUTE },
  });

  expect((await f.schedule({ endsAt: "2026-10-22T10:20:00Z" })).status).toBe(200);
  f.clock.now = START + 2 * MINUTE;
  expect(await f.projection()).toEqual({
    created: 10 * MINUTE,
    tick: { eventNowMs: 2 * MINUTE, matchDurationMs: 20 * MINUTE },
  });

  expect((await f.lock("POST")).status).toBe(200);
  f.clock.now = START + 5 * MINUTE;
  expect((await f.lock("DELETE")).status).toBe(200);
  f.clock.now = START + 6 * MINUTE;
  expect(await f.projection()).toEqual({
    created: 10 * MINUTE,
    tick: { eventNowMs: 3 * MINUTE, matchDurationMs: 17 * MINUTE },
  });
});

test("a Battle started without an end receives no match length until one is reserved", async () => {
  const f = await fixture();
  f.clock.now = START;
  expect((await f.schedule({ startNow: true })).status).toBe(200);

  f.clock.now = START + MINUTE;
  expect(await f.projection()).toEqual({
    created: null,
    tick: { eventNowMs: MINUTE, matchDurationMs: null },
  });

  expect((await f.schedule({ endsAt: "2026-10-22T10:30:00Z" })).status).toBe(200);
  f.clock.now = START + 2 * MINUTE;
  expect(await f.projection()).toEqual({
    created: null,
    tick: { eventNowMs: 2 * MINUTE, matchDurationMs: 30 * MINUTE },
  });
});
