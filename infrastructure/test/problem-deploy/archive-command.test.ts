import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events";
import { createCloudArchiveCommands } from "../../lib/problem-deploy/handlers/event-handler/archive";
import { eventRuntimeFixture } from "./event-runtime.test-helpers";

const nowMs = 1_700_000_000_000;
describe.each(["dynamodb", "turso"] as const)("Cloud archive command: %s", (backend) => {
  it("keeps state-only conditional archive, one concurrent winner and duplicate/tenant conflicts", async () => {
    const { shared, runtime, close } = eventRuntimeFixture(backend);
    try {
      const events = await runtime.resolveEventsRepository(shared);
      const record: EventRecord = {
        tenantId: "tenant-a",
        eventId: "event",
        name: "Retained event",
        status: "DRAFT",
        problems: [],
        teamCount: 0,
        createdAt: new Date(nowMs - 1000).toISOString(),
        updatedAt: new Date(nowMs - 1000).toISOString(),
        expiresAt: 4102444800,
      };
      await events.putEvent(record);
      const commands = createCloudArchiveCommands(shared);
      const request = { tenantId: "tenant-a", eventId: "event", nowMs };
      expect(await commands.archive({ ...request, tenantId: "tenant-b" })).toEqual({
        kind: "not_found",
      });
      expect(await commands.archive({ ...request, eventId: "missing" })).toEqual({
        kind: "not_found",
      });
      const results = await Promise.all([commands.archive(request), commands.archive(request)]);
      expect(results.map((result) => result.kind).sort()).toEqual(["not_archivable", "ok"]);
      expect(results.find((result) => result.kind === "ok")).toEqual({
        kind: "ok",
        archivedAt: new Date(nowMs).toISOString(),
      });
      const archived = await events.getEvent("tenant-a", "event");
      expect(archived).toEqual({
        ...record,
        status: "ARCHIVED",
        archivedAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      });
      expect(await commands.archive({ ...request, nowMs: nowMs + 1000 })).toEqual({
        kind: "not_archivable",
        status: "ARCHIVED",
      });
      expect(await events.getEvent("tenant-a", "event")).toEqual(archived);
      for (const status of ["READY", "DEPLOYING"] as const) {
        await events.putEvent({ ...record, status });
        expect(await commands.archive(request)).toEqual({ kind: "not_archivable", status });
        expect(await events.getEvent("tenant-a", "event")).toEqual({ ...record, status });
      }
      for (const status of ["ENDED", "TEARDOWN"] as const) {
        await events.putEvent({ ...record, status });
        expect(await commands.archive(request)).toEqual({
          kind: "ok",
          archivedAt: new Date(nowMs).toISOString(),
        });
      }
      const repositories = await runtime.resolveRepositories(shared);
      const failure = new Error("archive provider unavailable");
      const write = vi.spyOn(repositories.events, "archiveEvent").mockRejectedValue(failure);
      vi.spyOn(runtime, "resolveRepositories").mockResolvedValue(repositories);
      await expect(commands.archive(request)).rejects.toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });
});
