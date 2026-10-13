import { expect, spyOn, test } from "bun:test";
import { id } from "../auth";
import { eventHostFixture, eventRequest } from "./event-host.test-helpers";

test("Local list/detail preserve IDs, DTO, read-time lifecycle persistence and fresh snapshots", async () => {
  await eventHostFixture(async ({ store, service, token, eventId, clock }) => {
    const list = await service.admin(eventRequest("/events", token));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      items: [{ eventId, status: "ENDED", teamCount: 0, problemCount: 0 }],
    });
    expect(store.event(eventId).status).toBe("ENDED");
    expect(store.event(eventId).updatedAt).toBe(new Date(clock.now).toISOString());
    const detail = await service.admin(eventRequest(`/events/${eventId}`, token));
    expect(detail.body).toMatchObject({
      eventId,
      status: "ENDED",
      teams: [],
      problems: [],
      deploymentsByProblem: {},
    });
    expect(detail.body).not.toHaveProperty("scoreEventsByTeam");
    const timeline = await service.admin(
      eventRequest(`/events/${eventId}`, token, "withScoreEvents=true"),
    );
    expect(timeline.body).toHaveProperty("scoreEventsByTeam", []);
    store.putEvent({ ...store.event(eventId), name: "Updated event" });
    expect((await service.admin(eventRequest(`/events/${eventId}`, token))).body).toHaveProperty(
      "name",
      "Updated event",
    );
  });
});

test("Local read permission remains separate from key disclosure; invalid/expired sessions and missing IDs fail", async () => {
  await eventHostFixture(async ({ service, token, eventId, clock }) => {
    await expect(
      service.admin(eventRequest(`/events/${eventId}`, token, "withTeamLoginKeys=true")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.admin(eventRequest("/events", "invalid"))).rejects.toMatchObject({
      status: 401,
    });
    await expect(service.admin(eventRequest(`/events/${id(3)}`, token))).rejects.toMatchObject({
      status: 404,
    });
    clock.now = 100_001;
    await expect(service.admin(eventRequest(`/events/${eventId}`, token))).rejects.toMatchObject({
      status: 401,
    });
  });
});

test("Local query failure is propagated instead of becoming an empty list", async () => {
  await eventHostFixture(async ({ store, service, token }) => {
    const failure = new Error("SQLite read failed");
    const read = spyOn(store, "events").mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(service.admin(eventRequest("/events", token))).rejects.toBe(failure);
    } finally {
      read.mockRestore();
    }
  });
});
