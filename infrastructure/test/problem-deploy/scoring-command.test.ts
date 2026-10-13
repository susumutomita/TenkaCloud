import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events";
import { createCloudScoringCommands } from "../../lib/problem-deploy/handlers/event-handler/lock-scoring";
import { eventRuntimeFixture } from "./event-runtime.test-helpers";

const nowMs = 1_700_000_000_000;
describe.each(["dynamodb", "turso"] as const)("Cloud scoring command: %s", (backend) => {
  it("preserves conditional conflicts, tenant isolation, audit and same-target concurrent retries", async () => {
    const { shared, runtime, close } = eventRuntimeFixture(backend);
    try {
      const events = await runtime.resolveEventsRepository(shared);
      const record: EventRecord = {
        tenantId: "tenant-a",
        eventId: "event",
        name: "Event",
        status: "READY",
        teamCount: 0,
        problems: [],
        createdAt: "initial",
        updatedAt: "initial",
        expiresAt: 4102444800,
      };
      await events.putEvent(record);
      const commands = createCloudScoringCommands(shared);
      const command = {
        tenantId: "tenant-a",
        eventId: "event",
        locked: true as const,
        lockedBy: "actor",
        nowMs,
      };
      const results = await Promise.all([commands.setLock(command), commands.setLock(command)]);
      expect(results.map((r) => r.kind).sort()).toEqual(["already", "ok"]);
      const locked = await events.getEvent("tenant-a", "event");
      expect(locked).toMatchObject({
        scoringLocked: true,
        scoringLockedBy: "actor",
        scoringLockedAt: new Date(nowMs).toISOString(),
      });
      expect(await commands.setLock({ ...command, nowMs: nowMs + 1000 })).toEqual({
        kind: "already",
        scoringLocked: true,
      });
      expect(await events.getEvent("tenant-a", "event")).toEqual(locked);
      expect(await commands.setLock({ ...command, tenantId: "tenant-b" })).toEqual({
        kind: "not_found",
      });
      expect(await commands.setLock({ ...command, eventId: "missing" })).toEqual({
        kind: "not_found",
      });
      expect(
        await commands.setLock({ tenantId: "tenant-a", eventId: "event", locked: false, nowMs }),
      ).toEqual({ kind: "ok", scoringLocked: false });
      const unlocked = await events.getEvent("tenant-a", "event");
      expect(unlocked).not.toHaveProperty("scoringLocked");
      expect(unlocked).not.toHaveProperty("scoringLockedBy");
      expect(
        await commands.setLock({ tenantId: "tenant-a", eventId: "event", locked: false, nowMs }),
      ).toEqual({ kind: "already", scoringLocked: false });
      await events.putEvent({ ...record, status: "DRAFT" });
      expect(
        await commands.setLock({ tenantId: "tenant-a", eventId: "event", locked: false, nowMs }),
      ).toEqual({ kind: "not_lockable", status: "DRAFT" });
      const failure = new Error("provider write failed");
      const repositories = await runtime.resolveRepositories(shared);
      const write = vi.spyOn(repositories.events, "lockScoring").mockRejectedValue(failure);
      // Reuse the selected repository in this failure fixture; do not replace its normal mutations.
      vi.spyOn(runtime, "resolveRepositories").mockResolvedValue(repositories);
      await expect(commands.setLock(command)).rejects.toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });
});
