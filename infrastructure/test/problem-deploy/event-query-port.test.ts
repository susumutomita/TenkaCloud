import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events";
import {
  createCloudEventQueries,
  getEventDetail,
} from "../../lib/problem-deploy/handlers/event-handler/list";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeFakeDdb } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

// Real libSQL file-mode driver and schema; network SSM/DynamoDB are disposable test adapters.
describe.each(["dynamodb", "turso"] as const)("Cloud event query port: %s", (backend) => {
  it("keeps paging, tenant ownership, detail projection and stored records through the selected runtime", async () => {
    const client = createClient({ url: "file::memory:" });
    const runtime = makeTestControlDataRuntime(
      backend === "turso"
        ? {
            CONTROL_DATA_BACKEND: "turso",
            TURSO_DATABASE_URL: "libsql://fixture.invalid",
            TURSO_AUTH_TOKEN_PARAMETER_NAME: "/fixture/token",
          }
        : {},
      {
        ssm: {
          send: vi
            .fn()
            .mockResolvedValue({ Parameter: { Type: "SecureString", Value: randomUUID() } }),
        },
        createClient: () => client,
      },
    );
    const shared = {
      runtime,
      ddb: makeFakeDdb(),
      eventsTableName: "Events",
      teamsTableName: "Teams",
      deploymentsTableName: "Deployments",
    } as unknown as EventSharedResources;
    try {
      const events = await runtime.resolveEventsRepository(shared);
      const record: EventRecord = {
        tenantId: "tenant-a",
        eventId: "old",
        name: "Old event",
        status: "READY",
        problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
        teamCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        expiresAt: 4102444800,
        endsAt: "2026-01-02T00:00:00Z",
      };
      await events.putEvent(record);
      await events.putEvent({ ...record, eventId: "new", createdAt: "2026-02-01T00:00:00Z" });
      await events.putEvent({ ...record, eventId: "foreign", tenantId: "tenant-b" });
      const queries = createCloudEventQueries(shared);
      const page = await queries.list({ tenantId: "tenant-a", limit: 1 });
      expect(page.items.map((event) => event.eventId)).toEqual(["new"]);
      expect(page.nextCursor).toBeTruthy();
      const next = await queries.list({ tenantId: "tenant-a", limit: 1, cursor: page.nextCursor });
      expect(next.items.map((event) => event.eventId)).toEqual(["old"]);
      expect(next.nextCursor).toBeUndefined();
      expect(await queries.detail({ tenantId: "tenant-b", eventId: "old" })).toBeUndefined();
      expect(await queries.detail({ tenantId: "tenant-a", eventId: "absent" })).toBeUndefined();
      expect(await queries.list({ tenantId: "absent" })).toEqual({
        items: [],
        nextCursor: undefined,
      });
      // Structurally wider JS/TS options cannot replace the positional tenant/event scope.
      const widerOptions = { withScoreEvents: false, tenantId: "tenant-a", eventId: "new" };
      expect(await getEventDetail(shared, "tenant-b", "old", widerOptions)).toBeUndefined();
      const positionalDetail = await getEventDetail(shared, "tenant-a", "old", widerOptions);
      expect(positionalDetail?.eventId).toBe("old");
      const detail = await queries.detail({ tenantId: "tenant-a", eventId: "old" });
      expect(detail).toMatchObject({
        eventId: "old",
        status: "READY",
        teams: [],
        problems: record.problems,
      });
      expect(detail).not.toHaveProperty("tenantId");
      expect(detail).not.toHaveProperty("scoreEventsByTeam");
      expect(await events.getEvent("tenant-a", "old")).toEqual(record);
    } finally {
      client.close();
    }
  });
});

it("propagates repository failures rather than reporting an empty successful list or missing detail", async () => {
  const failure = new Error("query provider unavailable");
  const shared = {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: vi.fn().mockRejectedValue(failure) },
    eventsTableName: "Events",
    teamsTableName: "Teams",
    deploymentsTableName: "Deployments",
  } as unknown as EventSharedResources;
  const queries = createCloudEventQueries(shared);
  await expect(queries.list({ tenantId: "tenant-a" })).rejects.toBe(failure);
  await expect(queries.detail({ tenantId: "tenant-a", eventId: "event" })).rejects.toBe(failure);
});
