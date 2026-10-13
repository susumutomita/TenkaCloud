import { expect, spyOn, test } from "bun:test";
import { eventHostFixture, eventRequest } from "./event-host.test-helpers";

const command = (eventId: string, token: string) => ({
  ...eventRequest(`/events/${eventId}/archive`, token),
  method: "POST",
});

test("Local concurrent archive has one winner, retains data and rejects retries without a second write", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    store.putEvent({ ...store.event(eventId), status: "DRAFT" });
    const before = store.event(eventId);
    const teams = store.teams(eventId);
    const jobs = store.jobs(eventId);
    const writes = spyOn(store, "putEvent");
    try {
      const results = await Promise.allSettled([
        service.admin(command(eventId, token)),
        service.admin(command(eventId, token)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { status: 409 },
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(store.event(eventId)).toEqual({
        ...before,
        status: "ARCHIVED",
        updatedAt: new Date(10_000).toISOString(),
      });
      expect(store.teams(eventId)).toEqual(teams);
      expect(store.jobs(eventId)).toEqual(jobs);
      await expect(service.admin(command(eventId, token))).rejects.toMatchObject({ status: 409 });
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
    }
  }, "Admin");
});

test("Local archive rolls back an actual save if the provider throws, then an explicit retry succeeds", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    store.putEvent({ ...store.event(eventId), status: "DRAFT" });
    const before = store.event(eventId);
    const failure = new Error("archive commit failed");
    const original = store.putEvent.bind(store);
    const write = spyOn(store, "putEvent").mockImplementation((event) => {
      original(event);
      throw failure;
    });
    try {
      await expect(service.admin(command(eventId, token))).rejects.toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
      expect(store.event(eventId)).toEqual(before);
    } finally {
      write.mockRestore();
    }
    expect((await service.admin(command(eventId, token))).status).toBe(200);
  }, "Admin");
});

test("Local archive checks status before jobs and keeps Viewer and invalid session denials", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    store.putEvent({ ...store.event(eventId), status: "DEPLOYING" });
    const jobs = spyOn(store, "jobs").mockImplementation(() => {
      throw new Error("jobs must not be read");
    });
    try {
      await expect(service.admin(command(eventId, token))).rejects.toMatchObject({ status: 409 });
      expect(jobs).not.toHaveBeenCalled();
    } finally {
      jobs.mockRestore();
    }
    await expect(service.admin(command(eventId, "invalid"))).rejects.toMatchObject({ status: 401 });
  }, "Admin");
  await eventHostFixture(async ({ service, token, eventId }) => {
    await expect(service.admin(command(eventId, token))).rejects.toMatchObject({ status: 403 });
  });
});
