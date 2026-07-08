import { describe, expect, it, vi } from "vitest";
import {
  MirroredEventsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories.js";
import type {
  EventRecord,
  EventsRepository,
  TeamRecord,
  TeamsRepository,
} from "../../../lib/problem-deploy/control-data/types.js";

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "event-1",
    tenantId: "tenant-1",
    name: "Cup",
    status: "DRAFT",
    problems: [],
    teamCount: 1,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

function team(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    eventId: "event-1",
    teamId: "team-1",
    tenantId: "tenant-1",
    internalSlug: "alpha",
    teamLoginKey: "key-1",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

function memoryEvents(initial: readonly EventRecord[] = []): {
  readonly repo: EventsRepository;
  readonly records: Map<string, EventRecord>;
} {
  const records = new Map(initial.map((record) => [record.eventId, record]));
  return {
    records,
    repo: {
      getEvent: async (tenantId, eventId) => {
        const record = records.get(eventId);
        return record?.tenantId === tenantId ? record : undefined;
      },
      putEvent: async (record) => {
        records.set(record.eventId, record);
      },
      deleteEvent: async (eventId) => {
        records.delete(eventId);
      },
      listEventsByTenant: async (tenantId) =>
        [...records.values()]
          .filter((record) => record.tenantId === tenantId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      pruneExpired: async (now) => {
        let deleted = 0;
        for (const [id, record] of records) {
          if (record.expiresAt > 0 && record.expiresAt <= now) {
            records.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      },
    },
  };
}

function memoryTeams(initial: readonly TeamRecord[] = []): {
  readonly repo: TeamsRepository;
  readonly records: Map<string, TeamRecord>;
} {
  const key = (eventId: string, teamId: string): string => `${eventId}:${teamId}`;
  const records = new Map(initial.map((record) => [key(record.eventId, record.teamId), record]));
  return {
    records,
    repo: {
      getTeam: async (tenantId, eventId, teamId) => {
        const record = records.get(key(eventId, teamId));
        return record?.tenantId === tenantId ? record : undefined;
      },
      getTeamByLoginKey: async (loginKey) =>
        [...records.values()].find((record) => record.teamLoginKey === loginKey),
      putTeam: async (record) => {
        records.set(key(record.eventId, record.teamId), record);
      },
      deleteTeam: async (eventId, teamId) => {
        records.delete(key(eventId, teamId));
      },
      listTeamsByEvent: async (eventId) =>
        [...records.values()]
          .filter((record) => record.eventId === eventId)
          .sort((left, right) => left.teamId.localeCompare(right.teamId)),
      pruneExpired: async (now) => {
        let deleted = 0;
        for (const [id, record] of records) {
          if (record.expiresAt > 0 && record.expiresAt <= now) {
            records.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      },
    },
  };
}

describe("MirroredEventsRepository", () => {
  it("should heal stale, missing, and deleted replica rows from canonical DynamoDB", async () => {
    const current = event({ name: "Current" });
    const second = event({
      eventId: "event-2",
      name: "Second",
      createdAt: "2026-07-04T01:00:00.000Z",
    });
    const canonical = memoryEvents([current, second]);
    const replica = memoryEvents([
      event({ name: "Stale" }),
      event({ eventId: "ghost", name: "Ghost" }),
    ]);
    const repository = new MirroredEventsRepository(canonical.repo, replica.repo);

    await expect(repository.getEvent("tenant-1", current.eventId)).resolves.toEqual(current);
    expect(replica.records.get(current.eventId)).toEqual(current);
    await expect(repository.getEvent("tenant-1", "ghost")).resolves.toBeUndefined();
    expect(replica.records.has("ghost")).toBe(false);
    await replica.repo.putEvent(event({ eventId: "ghost-2", name: "Ghost" }));
    await expect(repository.listEventsByTenant("tenant-1")).resolves.toEqual([second, current]);
    expect([...replica.records.keys()].sort()).toEqual(["event-1", "event-2"]);
  });

  it("should preserve DynamoDB-first writes and replica-first deletes/pruning", async () => {
    const order: string[] = [];
    const canonical = memoryEvents();
    const replica = memoryEvents();
    const canonicalPut = vi.spyOn(canonical.repo, "putEvent").mockImplementation(async (record) => {
      order.push("canonical-put");
      canonical.records.set(record.eventId, record);
    });
    const replicaPut = vi.spyOn(replica.repo, "putEvent").mockImplementation(async (record) => {
      order.push("replica-put");
      replica.records.set(record.eventId, record);
    });
    const repository = new MirroredEventsRepository(canonical.repo, replica.repo);
    const record = event({ expiresAt: 10 });

    await repository.putEvent(record);
    expect(order).toEqual(["canonical-put", "replica-put"]);
    expect(canonicalPut).toHaveBeenCalledOnce();
    expect(replicaPut).toHaveBeenCalledOnce();
    await expect(repository.pruneExpired(10)).resolves.toBe(1);
    await repository.putEvent(record);
    await repository.deleteEvent(record.eventId);
    expect(canonical.records.size).toBe(0);
    expect(replica.records.size).toBe(0);
  });
});

/**
 * [Issue #2437] Conditional-write mirroring: canonical (DDB) first, adopt its
 * outcome, apply the same domain operation to the replica only on a canonical
 * success, and fail loudly on replica errors (no silent fallback).
 */
describe("MirroredEventsRepository conditional writes (#2437)", () => {
  const AT = "2026-07-08T12:00:00.000Z";

  function stubEvents(overrides: Record<string, unknown>): EventsRepository {
    return overrides as unknown as EventsRepository;
  }

  it("should apply the same operation to the replica after a canonical updated outcome", async () => {
    const order: string[] = [];
    const canonicalEnd = vi.fn(async () => {
      order.push("canonical");
      return { outcome: "updated" as const, event: event({ status: "ENDED" }) };
    });
    const replicaEnd = vi.fn(async () => {
      order.push("replica");
      return { outcome: "updated" as const, event: event({ status: "ENDED" }) };
    });
    const repository = new MirroredEventsRepository(
      stubEvents({ endEvent: canonicalEnd }),
      stubEvents({ endEvent: replicaEnd }),
    );

    const result = await repository.endEvent("tenant-1", "event-1", AT);

    expect(result.outcome).toBe("updated");
    expect(order).toEqual(["canonical", "replica"]);
    expect(replicaEnd).toHaveBeenCalledWith("tenant-1", "event-1", AT);
  });

  it("should adopt the canonical outcome and skip the replica on conflict / not_found", async () => {
    const replicaLock = vi.fn();
    const repository = new MirroredEventsRepository(
      stubEvents({
        lockScoring: vi.fn(async () => ({
          outcome: "conflict" as const,
          event: event({ scoringLocked: true }),
        })),
        markTeardown: vi.fn(async () => ({ outcome: "not_found" as const })),
      }),
      stubEvents({ lockScoring: replicaLock, markTeardown: replicaLock }),
    );

    const conflict = await repository.lockScoring("tenant-1", "event-1", "sub", AT);
    expect(conflict.outcome).toBe("conflict");
    const notFound = await repository.markTeardown("tenant-1", "event-1", AT);
    expect(notFound).toEqual({ outcome: "not_found" });
    expect(replicaLock).not.toHaveBeenCalled();
  });

  it("should propagate a replica failure loudly after a canonical success", async () => {
    const repository = new MirroredEventsRepository(
      stubEvents({
        archiveEvent: vi.fn(async () => ({ outcome: "updated" as const })),
      }),
      stubEvents({
        archiveEvent: vi.fn(async () => {
          throw new Error("replica down");
        }),
      }),
    );

    await expect(repository.archiveEvent("tenant-1", "event-1", AT)).rejects.toThrow(
      "replica down",
    );
  });

  it("should mirror createEventWithTeams only after the canonical create succeeded", async () => {
    const created = event();
    const teams = [team()];
    const replicaCreate = vi.fn(async () => ({ outcome: "created" as const }));
    const repository = new MirroredEventsRepository(
      stubEvents({ createEventWithTeams: vi.fn(async () => ({ outcome: "created" as const })) }),
      stubEvents({ createEventWithTeams: replicaCreate }),
    );

    await expect(repository.createEventWithTeams(created, teams)).resolves.toEqual({
      outcome: "created",
    });
    expect(replicaCreate).toHaveBeenCalledWith(created, teams);

    const replicaConflictCreate = vi.fn();
    const conflicted = new MirroredEventsRepository(
      stubEvents({ createEventWithTeams: vi.fn(async () => ({ outcome: "conflict" as const })) }),
      stubEvents({ createEventWithTeams: replicaConflictCreate }),
    );
    await expect(conflicted.createEventWithTeams(created, teams)).resolves.toEqual({
      outcome: "conflict",
    });
    expect(replicaConflictCreate).not.toHaveBeenCalled();
  });

  it("should mirror lockScoring / markTeardown to the replica after a canonical success", async () => {
    const replicaLock = vi.fn(async () => ({ outcome: "updated" as const }));
    const replicaTeardown = vi.fn(async () => ({ outcome: "updated" as const }));
    const repository = new MirroredEventsRepository(
      stubEvents({
        lockScoring: vi.fn(async () => ({ outcome: "updated" as const, event: event() })),
        markTeardown: vi.fn(async () => ({ outcome: "updated" as const })),
      }),
      stubEvents({ lockScoring: replicaLock, markTeardown: replicaTeardown }),
    );

    await repository.lockScoring("tenant-1", "event-1", "sub", AT);
    await repository.markTeardown("tenant-1", "event-1", AT);

    expect(replicaLock).toHaveBeenCalledWith("tenant-1", "event-1", "sub", AT);
    expect(replicaTeardown).toHaveBeenCalledWith("tenant-1", "event-1", AT);
  });

  it("should mirror the remaining conditional writes with the same arguments", async () => {
    const gate = { gateProblemId: "p1", unlockTargetIds: ["p2"] };
    const patch = { endsAt: "2026-07-09T00:00:00.000Z" };
    const replicaCalls: Record<string, ReturnType<typeof vi.fn>> = {
      unlockScoring: vi.fn(async () => ({ outcome: "updated" as const })),
      updateSchedule: vi.fn(async () => ({ outcome: "updated" as const })),
      setProgressionGate: vi.fn(async () => ({ outcome: "updated" as const })),
      clearProgressionGate: vi.fn(async () => ({ outcome: "updated" as const, removed: true })),
      markDeploying: vi.fn(async () => ({ outcome: "updated" as const })),
      transitionStatus: vi.fn(async () => ({ outcome: "updated" as const })),
      markScheduleFired: vi.fn(async () => ({ outcome: "updated" as const })),
    };
    const canonicalCalls = {
      unlockScoring: vi.fn(async () => ({ outcome: "updated" as const })),
      updateSchedule: vi.fn(async () => ({ outcome: "updated" as const })),
      setProgressionGate: vi.fn(async () => ({ outcome: "updated" as const })),
      clearProgressionGate: vi.fn(async () => ({ outcome: "updated" as const, removed: true })),
      markDeploying: vi.fn(async () => ({ outcome: "updated" as const })),
      transitionStatus: vi.fn(async () => ({ outcome: "updated" as const })),
      markScheduleFired: vi.fn(async () => ({ outcome: "updated" as const })),
    };
    const repository = new MirroredEventsRepository(
      stubEvents(canonicalCalls),
      stubEvents(replicaCalls),
    );

    await repository.unlockScoring("tenant-1", "event-1", AT);
    await repository.updateSchedule("tenant-1", "event-1", patch, AT);
    await repository.setProgressionGate("tenant-1", "event-1", gate, AT);
    const cleared = await repository.clearProgressionGate("tenant-1", "event-1", AT);
    await repository.markDeploying("tenant-1", "event-1", AT);
    await repository.transitionStatus("tenant-1", "event-1", "DEPLOYING", "READY", AT);
    await repository.markScheduleFired("tenant-1", "event-1", "teardown", AT);

    expect(cleared).toEqual({ outcome: "updated", removed: true });
    expect(replicaCalls.unlockScoring).toHaveBeenCalledWith("tenant-1", "event-1", AT);
    expect(replicaCalls.updateSchedule).toHaveBeenCalledWith("tenant-1", "event-1", patch, AT);
    expect(replicaCalls.setProgressionGate).toHaveBeenCalledWith("tenant-1", "event-1", gate, AT);
    expect(replicaCalls.clearProgressionGate).toHaveBeenCalledWith("tenant-1", "event-1", AT);
    expect(replicaCalls.markDeploying).toHaveBeenCalledWith("tenant-1", "event-1", AT);
    expect(replicaCalls.transitionStatus).toHaveBeenCalledWith(
      "tenant-1",
      "event-1",
      "DEPLOYING",
      "READY",
      AT,
    );
    expect(replicaCalls.markScheduleFired).toHaveBeenCalledWith(
      "tenant-1",
      "event-1",
      "teardown",
      AT,
    );
  });
});

describe("MirroredEventsRepository listing/batch/count seam (#2438)", () => {
  function stubEvents(overrides: Record<string, unknown>): EventsRepository {
    return overrides as unknown as EventsRepository;
  }

  it("should delegate listEventsPage to canonical only", async () => {
    const canonicalPage = vi.fn(async () => ({ events: [event()], nextCursor: "cursor-1" }));
    const replica = vi.fn();
    const repository = new MirroredEventsRepository(
      stubEvents({ listEventsPage: canonicalPage }),
      stubEvents({ listEventsPage: replica }),
    );

    const result = await repository.listEventsPage("tenant-1", { limit: 10, cursor: "c" });

    expect(result).toEqual({ events: [event()], nextCursor: "cursor-1" });
    expect(canonicalPage).toHaveBeenCalledWith("tenant-1", { limit: 10, cursor: "c" });
    expect(replica).not.toHaveBeenCalled();
  });

  it("should delegate listEventsByStatus to canonical only", async () => {
    const canonicalByStatus = vi.fn(async () => [event({ status: "READY" })]);
    const replica = vi.fn();
    const repository = new MirroredEventsRepository(
      stubEvents({ listEventsByStatus: canonicalByStatus }),
      stubEvents({ listEventsByStatus: replica }),
    );

    const result = await repository.listEventsByStatus(["READY"]);

    expect(result).toEqual([event({ status: "READY" })]);
    expect(canonicalByStatus).toHaveBeenCalledWith(["READY"]);
    expect(replica).not.toHaveBeenCalled();
  });

  it("should delegate batchGetEvents to canonical only", async () => {
    const meta = new Map([["event-1", { scoringLocked: true, progressionGate: undefined }]]);
    const canonicalBatch = vi.fn(async () => meta);
    const replica = vi.fn();
    const repository = new MirroredEventsRepository(
      stubEvents({ batchGetEvents: canonicalBatch }),
      stubEvents({ batchGetEvents: replica }),
    );

    const result = await repository.batchGetEvents(["event-1"]);

    expect(result).toBe(meta);
    expect(canonicalBatch).toHaveBeenCalledWith(["event-1"]);
    expect(replica).not.toHaveBeenCalled();
  });

  it("should delegate countEventsByTenant to canonical only", async () => {
    const canonicalCount = vi.fn(async () => 3);
    const replica = vi.fn();
    const repository = new MirroredEventsRepository(
      stubEvents({ countEventsByTenant: canonicalCount }),
      stubEvents({ countEventsByTenant: replica }),
    );

    const result = await repository.countEventsByTenant("tenant-1");

    expect(result).toBe(3);
    expect(canonicalCount).toHaveBeenCalledWith("tenant-1");
    expect(replica).not.toHaveBeenCalled();
  });
});

describe("MirroredTeamsRepository", () => {
  it("should heal team point, login-key, and event-list reads", async () => {
    const current = team({ internalSlug: "current" });
    const second = team({ teamId: "team-2", teamLoginKey: "key-2" });
    const third = team({ teamId: "team-3", teamLoginKey: "key-3" });
    const canonical = memoryTeams([current, second, third]);
    const replica = memoryTeams([
      team({ internalSlug: "stale" }),
      team({ teamId: "ghost", teamLoginKey: "ghost-point-key" }),
    ]);
    const repository = new MirroredTeamsRepository(canonical.repo, replica.repo);

    await expect(repository.getTeam("tenant-1", "event-1", "team-1")).resolves.toEqual(current);
    await expect(repository.getTeam("tenant-1", "event-1", "missing")).resolves.toBeUndefined();
    await expect(repository.getTeam("tenant-1", "event-1", "ghost")).resolves.toBeUndefined();
    await expect(repository.getTeamByLoginKey("key-2")).resolves.toEqual(second);
    await replica.repo.putTeam(team({ teamId: "login-ghost", teamLoginKey: "ghost-key" }));
    await expect(repository.getTeamByLoginKey("ghost-key")).resolves.toBeUndefined();
    await replica.repo.putTeam(team({ teamId: "ghost-2", teamLoginKey: "ghost-key-2" }));
    await expect(repository.listTeamsByEvent("event-1")).resolves.toEqual([current, second, third]);
    expect([...replica.records.keys()].sort()).toEqual([
      "event-1:team-1",
      "event-1:team-2",
      "event-1:team-3",
    ]);
  });

  it("should mirror writes and remove the replica before canonical deletion", async () => {
    const order: string[] = [];
    const canonical = memoryTeams();
    const replica = memoryTeams();
    const canonicalDelete = vi
      .spyOn(canonical.repo, "deleteTeam")
      .mockImplementation(async (eventId, teamId) => {
        order.push("canonical-delete");
        canonical.records.delete(`${eventId}:${teamId}`);
      });
    const replicaDelete = vi
      .spyOn(replica.repo, "deleteTeam")
      .mockImplementation(async (eventId, teamId) => {
        order.push("replica-delete");
        replica.records.delete(`${eventId}:${teamId}`);
      });
    const repository = new MirroredTeamsRepository(canonical.repo, replica.repo);
    const record = team({ expiresAt: 10 });

    await repository.putTeam(record);
    await repository.deleteTeam(record.eventId, record.teamId);
    expect(order).toEqual(["replica-delete", "canonical-delete"]);
    expect(replicaDelete).toHaveBeenCalledOnce();
    expect(canonicalDelete).toHaveBeenCalledOnce();
    await repository.putTeam(record);
    await expect(repository.pruneExpired(10)).resolves.toBe(1);
  });
});
