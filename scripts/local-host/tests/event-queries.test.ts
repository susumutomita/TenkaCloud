import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { id, randomToken } from "../auth";
import type { ApiRequest } from "../service";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

async function fixture(
  run: (context: {
    store: HostStore;
    service: HostingService;
    token: string;
    eventId: string;
    clock: { now: number };
  }) => Promise<void>,
) {
  const store = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture((path) => new Database(path));
  const clock = { now: 10_000 };
  const user = {
    id: id(1),
    username: "viewer",
    role: "Viewer" as const,
    status: "active" as const,
    authVersion: 1,
    passwordHash: randomToken(),
    createdAt: 1,
  };
  const identity = store.bootstrap(user);
  const token = randomToken();
  store.addSession(token, randomToken(), 100_000, 1, user, identity);
  const eventId = id(2);
  store.putEvent({
    eventId,
    name: "Existing event",
    status: "READY",
    problems: [],
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    expiresAt: 4102444800,
    endsAt: new Date(9_000).toISOString(),
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
  });
  const service = new HostingService(
    store,
    engine,
    randomToken(),
    () => clock.now,
    () => undefined,
  );
  try {
    await run({ store, service, token, eventId, clock });
  } finally {
    await engine.close();
    store.close();
  }
}

function request(path: string, token: string, query = ""): ApiRequest {
  return { path, token, body: undefined, method: "GET", query: new URLSearchParams(query) };
}

test("Local list/detail preserve IDs, DTO, read-time lifecycle persistence and fresh snapshots", async () => {
  await fixture(async ({ store, service, token, eventId, clock }) => {
    const list = await service.admin(request("/events", token));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      items: [{ eventId, status: "ENDED", teamCount: 0, problemCount: 0 }],
    });
    expect(store.event(eventId).status).toBe("ENDED");
    expect(store.event(eventId).updatedAt).toBe(new Date(clock.now).toISOString());
    const detail = await service.admin(request(`/events/${eventId}`, token));
    expect(detail.body).toMatchObject({
      eventId,
      status: "ENDED",
      teams: [],
      problems: [],
      deploymentsByProblem: {},
    });
    expect(detail.body).not.toHaveProperty("scoreEventsByTeam");
    const timeline = await service.admin(
      request(`/events/${eventId}`, token, "withScoreEvents=true"),
    );
    expect(timeline.body).toHaveProperty("scoreEventsByTeam", []);
    store.putEvent({ ...store.event(eventId), name: "Updated event" });
    expect((await service.admin(request(`/events/${eventId}`, token))).body).toHaveProperty(
      "name",
      "Updated event",
    );
  });
});

test("Local read permission remains separate from key disclosure; invalid/expired sessions and missing IDs fail", async () => {
  await fixture(async ({ service, token, eventId, clock }) => {
    await expect(
      service.admin(request(`/events/${eventId}`, token, "withTeamLoginKeys=true")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.admin(request("/events", "invalid"))).rejects.toMatchObject({
      status: 401,
    });
    await expect(service.admin(request(`/events/${id(3)}`, token))).rejects.toMatchObject({
      status: 404,
    });
    clock.now = 100_001;
    await expect(service.admin(request(`/events/${eventId}`, token))).rejects.toMatchObject({
      status: 401,
    });
  });
});

test("Local query failure is propagated instead of becoming an empty list", async () => {
  await fixture(async ({ store, service, token }) => {
    const failure = new Error("SQLite read failed");
    const read = spyOn(store, "events").mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(service.admin(request("/events", token))).rejects.toBe(failure);
    } finally {
      read.mockRestore();
    }
  });
});
