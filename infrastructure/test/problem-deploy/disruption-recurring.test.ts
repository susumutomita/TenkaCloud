import { DeleteScheduleCommand, ResourceNotFoundException } from "@aws-sdk/client-scheduler";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelRecurring,
  listActiveRecurring,
} from "../../lib/problem-deploy/handlers/event-handler/disruption-recurring";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * recurring の一覧 / 早期解除を pin する。 list は未 cancel + 未到達 だけを返し、
 * cancel は affectedTeamIds 分の `tc-recur-*` を DeleteSchedule (ResourceNotFound は冪等に無視) し、
 * registry へ cancelledAt を刻むことを観察する。
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function makeShared(ddbSend: ReturnType<typeof vi.fn>, schedulerSend: ReturnType<typeof vi.fn>) {
  return {
    runtime: makeTestControlDataRuntime(),
    disruptionsTableName: "Disruptions",
    ddb: { send: ddbSend },
    scheduler: { send: schedulerSend },
  } as unknown as EventSharedResources;
}

describe("listActiveRecurring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return only schedules that are neither cancelled nor past their endsAt", async () => {
    const ddbSend = vi.fn().mockResolvedValue({
      Items: [
        {
          requestId: "r-active",
          problemId: "p",
          disruptionId: "d",
          firedBy: "op",
          firedAt: "2026-06-17T23:00:00.000Z",
          scope: "all",
          affectedTeamIds: ["t1", "t2"],
          intervalMinutes: 5,
          maxFires: 6,
          endsAt: "2026-06-18T01:00:00.000Z", // future → active
        },
        {
          requestId: "r-cancelled",
          endsAt: "2026-06-18T02:00:00.000Z",
          cancelledAt: "2026-06-18T00:00:00.000Z", // cancelled → excluded
        },
        {
          requestId: "r-expired",
          endsAt: "2026-06-17T00:00:00.000Z", // past → excluded
        },
      ],
    });
    const out = await listActiveRecurring(makeShared(ddbSend, vi.fn()), "evt-1", "tenant-1", NOW);
    expect(out.items.map((i) => i.requestId)).toEqual(["r-active"]);
    expect(out.items[0]).toMatchObject({
      intervalMinutes: 5,
      maxFires: 6,
      affectedTeamIds: ["t1", "t2"],
    });
    const query = ddbSend.mock.calls[0][0];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input.FilterExpression).toContain("tenantId");
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ":pk": "EVENT#evt-1",
      ":p": "RECUR#",
      ":t": "tenant-1",
    });
  });

  it("should tolerate a registry row missing affectedTeamIds (defaults to empty)", async () => {
    const ddbSend = vi.fn().mockResolvedValue({
      Items: [{ requestId: "r1", endsAt: "2026-06-18T01:00:00.000Z" }],
    });
    const out = await listActiveRecurring(makeShared(ddbSend, vi.fn()), "evt-1", "tenant-1", NOW);
    expect(out.items[0]?.affectedTeamIds).toEqual([]);
  });
});

describe("cancelRecurring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should delete each per-team schedule and stamp cancelledAt on the registry row", async () => {
    const ddbSend = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({
          Item: { requestId: "r1", tenantId: "tenant-1", affectedTeamIds: ["t1", "t2"] },
        });
      }
      return Promise.resolve({});
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const out = await cancelRecurring(
      makeShared(ddbSend, schedulerSend),
      "evt-1",
      "tenant-1",
      "r1",
      NOW,
    );
    expect(out).toBe("cancelled");
    // one DeleteSchedule per affected team, named tc-recur-{requestId}-{teamId}
    const deletes = schedulerSend.mock.calls.map((c) => c[0]);
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toBeInstanceOf(DeleteScheduleCommand);
    expect(deletes.map((d) => d.input.Name)).toEqual(["tc-recur-r1-t1", "tc-recur-r1-t2"]);
    // registry row stamped cancelledAt
    const update = ddbSend.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0];
    expect(update.input.UpdateExpression).toContain("cancelledAt");
  });

  it("should return not_found and touch nothing when the registry row is absent", async () => {
    const ddbSend = vi.fn().mockResolvedValue({}); // GetCommand → no Item
    const schedulerSend = vi.fn();
    const out = await cancelRecurring(
      makeShared(ddbSend, schedulerSend),
      "evt-1",
      "tenant-1",
      "missing",
      NOW,
    );
    expect(out).toBe("not_found");
    expect(schedulerSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
  });

  it("should return not_found (without leaking existence) for another tenant's requestId", async () => {
    const ddbSend = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({ Item: { tenantId: "other-tenant", affectedTeamIds: ["t1"] } });
      }
      return Promise.resolve({});
    });
    const schedulerSend = vi.fn();
    const out = await cancelRecurring(
      makeShared(ddbSend, schedulerSend),
      "evt-1",
      "tenant-1",
      "r1",
      NOW,
    );
    expect(out).toBe("not_found");
    expect(schedulerSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
  });

  it("should ignore a schedule already auto-deleted at EndDate (ResourceNotFound) and still cancel", async () => {
    const ddbSend = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({ Item: { tenantId: "tenant-1", affectedTeamIds: ["t1"] } });
      }
      return Promise.resolve({});
    });
    const schedulerSend = vi
      .fn()
      .mockRejectedValue(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    const out = await cancelRecurring(
      makeShared(ddbSend, schedulerSend),
      "evt-1",
      "tenant-1",
      "r1",
      NOW,
    );
    expect(out).toBe("cancelled");
    expect(ddbSend.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(true);
  });

  it("should propagate non-ResourceNotFound scheduler errors (loud failure)", async () => {
    const ddbSend = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({ Item: { tenantId: "tenant-1", affectedTeamIds: ["t1"] } });
      }
      return Promise.resolve({});
    });
    const schedulerSend = vi.fn().mockRejectedValue(new Error("AccessDenied"));
    await expect(
      cancelRecurring(makeShared(ddbSend, schedulerSend), "evt-1", "tenant-1", "r1", NOW),
    ).rejects.toThrow("AccessDenied");
  });
});
