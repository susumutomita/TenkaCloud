import { describe, expect, it, vi } from "vitest";
import {
  MirroredDeploymentsRepository,
  MirroredEventsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories.js";
import type {
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsRepository,
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

/**
 * [Issue #2441] `MirroredDeploymentsRepository`: reads/scans pass through to
 * canonical DynamoDB (deployment cursors and page boundaries are
 * backend-specific), writes commit to canonical first, and conditional writes
 * mirror to the replica only after a canonical `updated` outcome.
 */
describe("MirroredDeploymentsRepository", () => {
  const AT = "2026-07-08T12:00:00.000Z";

  function deploymentRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
    return {
      jobId: "job-1",
      problemId: "problem-1",
      tenantId: "tenant-1",
      awsAccountId: "111111111111",
      region: "us-east-1",
      teamName: "Team",
      namePrefix: "tc-team",
      teamLoginKey: "key-1",
      status: "PENDING",
      createdAt: AT,
      updatedAt: AT,
      expiresAt: 4_102_444_800,
      ...overrides,
    };
  }

  function stubDeployments(overrides: Record<string, unknown>): DeploymentsRepository {
    return overrides as unknown as DeploymentsRepository;
  }

  it("should delegate every read-only method to canonical DynamoDB without touching the replica", async () => {
    const record = deploymentRecord();
    const page = { items: [record], nextCursor: "cursor-1" };
    const onPage = vi.fn(async () => {});
    const canonical = {
      getDeployment: vi.fn(async () => record),
      queryDeploymentMeta: vi.fn(async () => record),
      listByTenantPage: vi.fn(async () => page),
      countActiveByTenant: vi.fn(async () => 3),
      listByTenantAndEvent: vi.fn(async () => [record]),
      listDeploymentKeysByEvent: vi.fn(async () => [record.jobId]),
      listReconcilerRowsByEvent: vi.fn(async () => [
        { jobId: record.jobId, status: record.status, updatedAt: record.updatedAt },
      ]),
      listByEventTeamProblem: vi.fn(async () => [record]),
      findByNamePrefix: vi.fn(async () => [
        { namePrefix: record.namePrefix, jobId: record.jobId, status: record.status },
      ]),
      listDeploymentSummariesByTenant: vi.fn(async () => [record]),
      listByTeamLoginKey: vi.fn(async () => [record]),
      listCompositeTargets: vi.fn(async () => [record]),
      listScoreEvents: vi.fn(async () => []),
      listScoreEventsInRange: vi.fn(async () => []),
      listInboxEventsInRange: vi.fn(async () => []),
      readCoordinationState: vi.fn(async () => ({ state: { foo: "bar" }, version: 1 })),
      forEachCompleteDeploymentPage: vi.fn(
        async (_eventId: string | undefined, cb: typeof onPage) => {
          await cb([record]);
        },
      ),
      forEachCompositeDeployReconcilablePage: vi.fn(async (cb: typeof onPage) => {
        await cb([record]);
      }),
      forEachCompositeTeardownPendingPage: vi.fn(async (cb: typeof onPage) => {
        await cb([record]);
      }),
      forEachRuntimeReconcilablePage: vi.fn(async (cb: typeof onPage) => {
        await cb([record]);
      }),
      forEachRuntimeScoreFeedPage: vi.fn(async (_eventId: string, cb: typeof onPage) => {
        await cb([record]);
      }),
    };
    const repository = new MirroredDeploymentsRepository(
      stubDeployments(canonical),
      stubDeployments({}),
    );

    await expect(repository.getDeployment("job-1")).resolves.toEqual(record);
    await expect(repository.queryDeploymentMeta("job-1")).resolves.toEqual(record);
    await expect(repository.listByTenantPage("tenant-1", { limit: 10 })).resolves.toEqual(page);
    await expect(
      repository.countActiveByTenant("tenant-1", ["PENDING"], { stopAtCount: 5 }),
    ).resolves.toBe(3);
    await expect(repository.listByTenantAndEvent("tenant-1", "event-1")).resolves.toEqual([record]);
    await expect(repository.listDeploymentKeysByEvent("tenant-1", "event-1")).resolves.toEqual([
      record.jobId,
    ]);
    await expect(repository.listReconcilerRowsByEvent("tenant-1", "event-1")).resolves.toEqual([
      { jobId: record.jobId, status: record.status, updatedAt: record.updatedAt },
    ]);
    await expect(
      repository.listByEventTeamProblem("tenant-1", "event-1", "team-1", "problem-1"),
    ).resolves.toEqual([record]);
    await expect(repository.findByNamePrefix("tenant-1", "tc-team")).resolves.toEqual([
      { namePrefix: record.namePrefix, jobId: record.jobId, status: record.status },
    ]);
    await expect(repository.listDeploymentSummariesByTenant("tenant-1")).resolves.toEqual([record]);
    await expect(repository.listByTeamLoginKey("key-1")).resolves.toEqual([record]);
    await expect(repository.listCompositeTargets("parent-1")).resolves.toEqual([record]);
    await expect(repository.listScoreEvents("job-1", { pageSize: 10 })).resolves.toEqual([]);
    await expect(repository.listScoreEventsInRange("job-1", "EVENT#a", "EVENT#z")).resolves.toEqual(
      [],
    );
    await expect(repository.listInboxEventsInRange("job-1", "INBOX#a", "INBOX#z")).resolves.toEqual(
      [],
    );
    await expect(repository.readCoordinationState("tenant-1", "event-1")).resolves.toEqual({
      state: { foo: "bar" },
      version: 1,
    });
    await repository.forEachCompleteDeploymentPage("event-1", onPage);
    await repository.forEachCompositeDeployReconcilablePage(onPage);
    await repository.forEachCompositeTeardownPendingPage(onPage);
    await repository.forEachRuntimeReconcilablePage(onPage);
    await repository.forEachRuntimeScoreFeedPage("event-1", onPage);

    expect(canonical.countActiveByTenant).toHaveBeenCalledWith("tenant-1", ["PENDING"], {
      stopAtCount: 5,
    });
    expect(onPage).toHaveBeenCalledTimes(5);
    for (const fn of Object.values(canonical)) {
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it("should write putDeployment / score events / inbox events to canonical before the replica", async () => {
    const order: string[] = [];
    const canonicalPut = vi.fn(async () => {
      order.push("canonical-put");
    });
    const replicaPut = vi.fn(async () => {
      order.push("replica-put");
    });
    const canonicalScore = vi.fn(async () => {
      order.push("canonical-score");
    });
    const replicaScore = vi.fn(async () => {
      order.push("replica-score");
    });
    const canonicalInbox = vi.fn(async () => {
      order.push("canonical-inbox");
    });
    const replicaInbox = vi.fn(async () => {
      order.push("replica-inbox");
    });
    const repository = new MirroredDeploymentsRepository(
      stubDeployments({
        putDeployment: canonicalPut,
        appendScoreEvent: canonicalScore,
        appendInboxEvent: canonicalInbox,
      }),
      stubDeployments({
        putDeployment: replicaPut,
        appendScoreEvent: replicaScore,
        appendInboxEvent: replicaInbox,
      }),
    );
    const record = deploymentRecord();
    const scoreEvent = {
      jobId: record.jobId,
      problemId: record.problemId,
      source: "flag" as const,
      points: 10,
      result: "ok" as const,
      occurredAt: AT,
      expiresAt: record.expiresAt,
    };

    await repository.putDeployment(record);
    await repository.appendScoreEvent(scoreEvent);
    await repository.appendInboxEvent(record.jobId, "inbox-1", { kind: "ping" });

    expect(order).toEqual([
      "canonical-put",
      "replica-put",
      "canonical-score",
      "replica-score",
      "canonical-inbox",
      "replica-inbox",
    ]);
    expect(canonicalPut).toHaveBeenCalledWith(record);
    expect(replicaPut).toHaveBeenCalledWith(record);
    expect(replicaScore).toHaveBeenCalledWith(scoreEvent);
    expect(replicaInbox).toHaveBeenCalledWith(record.jobId, "inbox-1", { kind: "ping" });
  });

  /**
   * [Issue #2441] Conditional-write mirroring: canonical (DDB) first, adopt its
   * outcome, apply the same domain operation to the replica only on a canonical
   * `updated` outcome, and fail loudly on replica errors (no silent fallback) —
   * the Deployments-aggregate counterpart of the `#2437` Events coverage above.
   */
  describe("mirrorWrite conditional writes", () => {
    it("should mirror the create/retry/delete lifecycle writes after a canonical updated outcome", async () => {
      const replicaCalls: Record<string, ReturnType<typeof vi.fn>> = {
        markCreateInProgress: vi.fn(async () => ({ outcome: "updated" as const })),
        markCreateSucceeded: vi.fn(async () => ({ outcome: "updated" as const })),
        markCreateFailed: vi.fn(async () => ({ outcome: "updated" as const })),
        markDeleted: vi.fn(async () => ({ outcome: "updated" as const })),
        markFailedIfPending: vi.fn(async () => ({ outcome: "updated" as const })),
        retryToPending: vi.fn(async () => ({ outcome: "updated" as const })),
        compensateRetryToFailed: vi.fn(async () => ({ outcome: "updated" as const })),
        markDeleting: vi.fn(async () => ({ outcome: "updated" as const })),
        compensateDeleteToFailed: vi.fn(async () => ({ outcome: "updated" as const })),
        markApprovalPending: vi.fn(async () => ({ outcome: "updated" as const })),
      };
      const canonicalCalls: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
        Object.keys(replicaCalls).map((key) => [
          key,
          vi.fn(async () => ({ outcome: "updated" as const })),
        ]),
      );
      const repository = new MirroredDeploymentsRepository(
        stubDeployments(canonicalCalls),
        stubDeployments(replicaCalls),
      );

      await repository.markCreateInProgress("job-1", AT);
      await repository.markCreateSucceeded("job-1", "stack-1", "{}", "build-1", AT);
      await repository.markCreateFailed("job-1", "boom", "build-1", AT);
      await repository.markDeleted("job-1", AT);
      await repository.markFailedIfPending("job-1", "tenant-1", "reason", AT, 10);
      await repository.retryToPending("job-1", "tenant-1", AT);
      await repository.compensateRetryToFailed("job-1", "tenant-1", "reason", AT, 10);
      await repository.markDeleting("job-1", "tenant-1", AT, 10);
      await repository.compensateDeleteToFailed("job-1", "tenant-1", "reason", AT, 10);
      await repository.markApprovalPending("job-1", "tenant-1", AT);

      expect(replicaCalls.markCreateInProgress).toHaveBeenCalledWith("job-1", AT);
      expect(replicaCalls.markCreateSucceeded).toHaveBeenCalledWith(
        "job-1",
        "stack-1",
        "{}",
        "build-1",
        AT,
      );
      expect(replicaCalls.markCreateFailed).toHaveBeenCalledWith("job-1", "boom", "build-1", AT);
      expect(replicaCalls.markDeleted).toHaveBeenCalledWith("job-1", AT);
      expect(replicaCalls.markFailedIfPending).toHaveBeenCalledWith(
        "job-1",
        "tenant-1",
        "reason",
        AT,
        10,
      );
      expect(replicaCalls.retryToPending).toHaveBeenCalledWith("job-1", "tenant-1", AT);
      expect(replicaCalls.compensateRetryToFailed).toHaveBeenCalledWith(
        "job-1",
        "tenant-1",
        "reason",
        AT,
        10,
      );
      expect(replicaCalls.markDeleting).toHaveBeenCalledWith("job-1", "tenant-1", AT, 10);
      expect(replicaCalls.compensateDeleteToFailed).toHaveBeenCalledWith(
        "job-1",
        "tenant-1",
        "reason",
        AT,
        10,
      );
      expect(replicaCalls.markApprovalPending).toHaveBeenCalledWith("job-1", "tenant-1", AT);
    });

    it("should mirror the composite / stuck / bulk-teardown writes after a canonical updated outcome", async () => {
      const compositeParent = {
        jobId: "parent-1",
        tenantId: "tenant-1",
        problemId: "problem-1",
        runtimeKind: "composite" as const,
        compositeVersion: 1,
        targetCount: 2,
        status: "PENDING" as const,
        createdAt: AT,
        updatedAt: AT,
        expiresAt: 10,
      };
      const compositeTarget = {
        ...deploymentRecord({ jobId: "target-1" }),
        parentDeploymentId: "parent-1",
        targetId: "target-1",
        targetOrdinal: 0,
        runtimeProvider: "aws",
        runtimeEngine: "cloudformation",
        runtimeEntry: "stack-1",
      };
      const replicaCalls: Record<string, ReturnType<typeof vi.fn>> = {
        failCompositeTargetIfPending: vi.fn(async () => ({ outcome: "updated" as const })),
        markCompositeParentDeleting: vi.fn(async () => ({ outcome: "updated" as const })),
        putCompositeParent: vi.fn(async () => ({ outcome: "updated" as const })),
        putCompositeTarget: vi.fn(async () => ({ outcome: "updated" as const })),
        markStuckDeletingFailed: vi.fn(async () => ({ outcome: "updated" as const })),
        transitionRuntimeStatus: vi.fn(async () => ({ outcome: "updated" as const })),
        compensateBulkTeardown: vi.fn(async () => ({ outcome: "updated" as const })),
        markDeletingForBulk: vi.fn(async () => ({ outcome: "updated" as const })),
      };
      const canonicalCalls: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
        Object.keys(replicaCalls).map((key) => [
          key,
          vi.fn(async () => ({ outcome: "updated" as const })),
        ]),
      );
      const repository = new MirroredDeploymentsRepository(
        stubDeployments(canonicalCalls),
        stubDeployments(replicaCalls),
      );

      await repository.failCompositeTargetIfPending("job-1", "reason", AT);
      await repository.markCompositeParentDeleting("parent-1", AT);
      await repository.putCompositeParent(compositeParent);
      await repository.putCompositeTarget(compositeTarget);
      await repository.markStuckDeletingFailed("job-1", "reason", AT);
      await repository.transitionRuntimeStatus(
        "job-1",
        "tenant-1",
        "IN_PROGRESS",
        "COMPLETE",
        "{}",
        AT,
      );
      await repository.compensateBulkTeardown("job-1", "tenant-1", AT);
      await repository.markDeletingForBulk("job-1", "tenant-1", AT);

      expect(replicaCalls.failCompositeTargetIfPending).toHaveBeenCalledWith("job-1", "reason", AT);
      expect(replicaCalls.markCompositeParentDeleting).toHaveBeenCalledWith("parent-1", AT);
      expect(replicaCalls.putCompositeParent).toHaveBeenCalledWith(compositeParent);
      expect(replicaCalls.putCompositeTarget).toHaveBeenCalledWith(compositeTarget);
      expect(replicaCalls.markStuckDeletingFailed).toHaveBeenCalledWith("job-1", "reason", AT);
      expect(replicaCalls.transitionRuntimeStatus).toHaveBeenCalledWith(
        "job-1",
        "tenant-1",
        "IN_PROGRESS",
        "COMPLETE",
        "{}",
        AT,
      );
      expect(replicaCalls.compensateBulkTeardown).toHaveBeenCalledWith("job-1", "tenant-1", AT);
      expect(replicaCalls.markDeletingForBulk).toHaveBeenCalledWith("job-1", "tenant-1", AT);
    });

    it("should mirror the scoring mutations after a canonical updated outcome", async () => {
      const hint = { hintId: "hint-1", revealedAt: AT, penaltyApplied: 5 };
      const kindResult = { scoreDelta: 10 };
      const gateParent = {
        jobId: "job-1",
        problemId: "problem-1",
        teamId: "team-1",
        eventId: "event-1",
        expiresAt: 10,
      };
      const replicaCalls: Record<string, ReturnType<typeof vi.fn>> = {
        applyMultiFlagCorrectScore: vi.fn(async () => ({ outcome: "updated" as const })),
        applyMultiFlagWrongPenalty: vi.fn(async () => ({ outcome: "updated" as const })),
        applyFlagWrongPenalty: vi.fn(async () => ({ outcome: "updated" as const })),
        applyFlagCorrectScore: vi.fn(async () => ({ outcome: "updated" as const })),
        applyHintPenalty: vi.fn(async () => ({ outcome: "updated" as const })),
        updateDisplayTeamName: vi.fn(async () => ({ outcome: "updated" as const })),
        applyKindScoringResult: vi.fn(async () => ({ outcome: "updated" as const })),
        casCompositeParentStatus: vi.fn(async () => ({ outcome: "updated" as const })),
        latchGateCompleted: vi.fn(async () => ({ outcome: "updated" as const })),
        awardGateBonusAtomic: vi.fn(async () => ({ outcome: "updated" as const })),
        setScoringState: vi.fn(async () => ({ outcome: "updated" as const })),
      };
      const canonicalCalls: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
        Object.keys(replicaCalls).map((key) => [
          key,
          vi.fn(async () => ({ outcome: "updated" as const })),
        ]),
      );
      const repository = new MirroredDeploymentsRepository(
        stubDeployments(canonicalCalls),
        stubDeployments(replicaCalls),
      );

      await repository.applyMultiFlagCorrectScore("job-1", 10, "flag-1", AT);
      await repository.applyMultiFlagWrongPenalty("job-1", 5, "flag-1", AT);
      await repository.applyFlagWrongPenalty("job-1", 5, AT);
      await repository.applyFlagCorrectScore("job-1", 10, AT);
      await repository.applyHintPenalty("job-1", hint, AT);
      await repository.updateDisplayTeamName("job-1", "New Name", AT);
      await repository.applyKindScoringResult("job-1", kindResult, AT);
      await repository.casCompositeParentStatus("job-1", "PENDING", "IN_PROGRESS", AT);
      await repository.latchGateCompleted("job-1", AT);
      await repository.awardGateBonusAtomic(gateParent, 10, AT);
      await repository.setScoringState("job-1", "{}", AT);

      expect(replicaCalls.applyMultiFlagCorrectScore).toHaveBeenCalledWith(
        "job-1",
        10,
        "flag-1",
        AT,
      );
      expect(replicaCalls.applyMultiFlagWrongPenalty).toHaveBeenCalledWith(
        "job-1",
        5,
        "flag-1",
        AT,
      );
      expect(replicaCalls.applyFlagWrongPenalty).toHaveBeenCalledWith("job-1", 5, AT);
      expect(replicaCalls.applyFlagCorrectScore).toHaveBeenCalledWith("job-1", 10, AT);
      expect(replicaCalls.applyHintPenalty).toHaveBeenCalledWith("job-1", hint, AT);
      expect(replicaCalls.updateDisplayTeamName).toHaveBeenCalledWith("job-1", "New Name", AT);
      expect(replicaCalls.applyKindScoringResult).toHaveBeenCalledWith("job-1", kindResult, AT);
      expect(replicaCalls.casCompositeParentStatus).toHaveBeenCalledWith(
        "job-1",
        "PENDING",
        "IN_PROGRESS",
        AT,
      );
      expect(replicaCalls.latchGateCompleted).toHaveBeenCalledWith("job-1", AT);
      expect(replicaCalls.awardGateBonusAtomic).toHaveBeenCalledWith(gateParent, 10, AT);
      expect(replicaCalls.setScoringState).toHaveBeenCalledWith("job-1", "{}", AT);
    });

    it("should mirror the bulk / schedule / coordination writes after a canonical updated outcome", async () => {
      const patch = { endsAt: "2026-07-09T00:00:00.000Z" };
      const entries = [{ record: deploymentRecord({ jobId: "job-2" }) }];
      const coordState = { foo: "bar" };
      const replicaCalls: Record<string, ReturnType<typeof vi.fn>> = {
        applySchedulePatch: vi.fn(async () => ({ outcome: "updated" as const })),
        createBulkDeployments: vi.fn(async () => ({ outcome: "updated" as const })),
        compensateBulkCreateToFailed: vi.fn(async () => ({ outcome: "updated" as const })),
        stampEventEndsAt: vi.fn(async () => ({ outcome: "updated" as const })),
        writeCoordinationState: vi.fn(async () => ({ outcome: "updated" as const })),
      };
      const canonicalCalls: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
        Object.keys(replicaCalls).map((key) => [
          key,
          vi.fn(async () => ({ outcome: "updated" as const })),
        ]),
      );
      const repository = new MirroredDeploymentsRepository(
        stubDeployments(canonicalCalls),
        stubDeployments(replicaCalls),
      );

      await repository.applySchedulePatch("job-1", "tenant-1", patch, AT);
      await repository.createBulkDeployments("tenant-1", entries);
      await repository.compensateBulkCreateToFailed("job-1", "tenant-1", "reason", AT);
      await repository.stampEventEndsAt("job-1", "tenant-1", AT, AT);
      await repository.writeCoordinationState("tenant-1", "event-1", coordState, 1, AT);

      expect(replicaCalls.applySchedulePatch).toHaveBeenCalledWith("job-1", "tenant-1", patch, AT);
      expect(replicaCalls.createBulkDeployments).toHaveBeenCalledWith("tenant-1", entries);
      expect(replicaCalls.compensateBulkCreateToFailed).toHaveBeenCalledWith(
        "job-1",
        "tenant-1",
        "reason",
        AT,
      );
      expect(replicaCalls.stampEventEndsAt).toHaveBeenCalledWith("job-1", "tenant-1", AT, AT);
      expect(replicaCalls.writeCoordinationState).toHaveBeenCalledWith(
        "tenant-1",
        "event-1",
        coordState,
        1,
        AT,
      );
    });

    it("should adopt the canonical outcome and skip the replica on conflict / not_found", async () => {
      const replicaMarkDeleted = vi.fn();
      const replicaRetry = vi.fn();
      const repository = new MirroredDeploymentsRepository(
        stubDeployments({
          markDeleted: vi.fn(
            async (): Promise<DeploymentMutationOutcome> => ({
              outcome: "conflict",
            }),
          ),
          retryToPending: vi.fn(
            async (): Promise<DeploymentMutationOutcome> => ({
              outcome: "not_found",
            }),
          ),
        }),
        stubDeployments({ markDeleted: replicaMarkDeleted, retryToPending: replicaRetry }),
      );

      const conflict = await repository.markDeleted("job-1", AT);
      expect(conflict.outcome).toBe("conflict");
      const notFound = await repository.retryToPending("job-1", "tenant-1", AT);
      expect(notFound).toEqual({ outcome: "not_found" });
      expect(replicaMarkDeleted).not.toHaveBeenCalled();
      expect(replicaRetry).not.toHaveBeenCalled();
    });

    it("should propagate a replica failure loudly after a canonical success", async () => {
      const repository = new MirroredDeploymentsRepository(
        stubDeployments({
          markApprovalPending: vi.fn(async () => ({ outcome: "updated" as const })),
        }),
        stubDeployments({
          markApprovalPending: vi.fn(async () => {
            throw new Error("replica down");
          }),
        }),
      );

      await expect(repository.markApprovalPending("job-1", "tenant-1", AT)).rejects.toThrow(
        "replica down",
      );
    });
  });
});
