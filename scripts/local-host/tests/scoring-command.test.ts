import { expect, spyOn, test } from "bun:test";
import { eventHostFixture, eventRequest } from "./event-host.test-helpers";

const mutation = (eventId: string, token: string, locked: boolean) => ({
  ...eventRequest(`/events/${eventId}/lock-scoring`, token),
  method: locked ? "POST" : "DELETE",
});

test("Local concurrent same-target commands commit once and retries retain timestamps", async () => {
  await eventHostFixture(async ({ store, service, token, eventId, clock }) => {
    store.putEvent({ ...store.event(eventId), status: "ENDED" });
    const writes = spyOn(store, "putEvent");
    try {
      const results = await Promise.all([
        service.admin(mutation(eventId, token, true)),
        service.admin(mutation(eventId, token, true)),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      expect(writes).toHaveBeenCalledTimes(1);
      const lockedAt = store.event(eventId).scoringLockedAt;
      clock.now += 1000;
      expect((await service.admin(mutation(eventId, token, true))).body).toHaveProperty(
        "scoringLockedAt",
        lockedAt,
      );
      expect(writes).toHaveBeenCalledTimes(1);
      await service.admin(mutation(eventId, token, false));
      expect(store.event(eventId).scoringLocked).toBe(false);
      expect(store.event(eventId).scoringLockedAt).toBeUndefined();
      expect(writes).toHaveBeenCalledTimes(2);
    } finally {
      writes.mockRestore();
    }
  }, "Admin");
});

test("Local failed save rolls back, propagates once, and a caller retry can succeed", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    store.putEvent({ ...store.event(eventId), status: "ENDED" });
    const before = store.event(eventId);
    const failure = new Error("command save failed");
    const save = spyOn(store, "putEvent").mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(service.admin(mutation(eventId, token, true))).rejects.toBe(failure);
      expect(save).toHaveBeenCalledTimes(1);
      expect(store.event(eventId)).toEqual(before);
    } finally {
      save.mockRestore();
    }
    expect((await service.admin(mutation(eventId, token, true))).status).toBe(200);
  }, "Admin");
});

test("Local status check precedes idempotency and Viewer commands remain forbidden", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    store.putEvent({ ...store.event(eventId), status: "DRAFT", scoringLocked: false });
    await expect(service.admin(mutation(eventId, token, false))).rejects.toMatchObject({
      status: 409,
    });
    expect(store.event(eventId).status).toBe("DRAFT");
  }, "Admin");
  await eventHostFixture(async ({ service, token, eventId }) => {
    await expect(service.admin(mutation(eventId, token, true))).rejects.toMatchObject({
      status: 403,
    });
  });
});

test("Local historical missing lock field still commits an explicit unlock", async () => {
  await eventHostFixture(async ({ store, service, token, eventId }) => {
    const historical = { ...store.event(eventId), status: "ENDED" as const };
    Reflect.deleteProperty(historical, "scoringLocked");
    store.putEvent(historical);
    const writes = spyOn(store, "putEvent");
    try {
      await service.admin(mutation(eventId, token, false));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(store.event(eventId).scoringLocked).toBe(false);
    } finally {
      writes.mockRestore();
    }
  }, "Admin");
});
