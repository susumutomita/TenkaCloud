import { describe, expect, it } from "vitest";
import {
  DynamoDbEventsRepository,
  type EventRecord,
  type EventsRepository,
  SqlEventsRepository,
} from "../../../lib/problem-deploy/control-data/events-repository";
import {
  DynamoDbTeamsRepository,
  SqlTeamsRepository,
  type TeamRecord,
  type TeamsRepository,
} from "../../../lib/problem-deploy/control-data/teams-repository";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2437 / Phase A2] Parity suite for the conditional/atomic Event
 * mutations. The SAME assertions run against both backends so the DynamoDB
 * implementation (verbatim relocation of the pre-seam handler expressions) and
 * the SQLite implementation (json_set/json_extract single-statement updates)
 * are provably interchangeable. Every method covers its updated / conflict /
 * not_found union branches; `createEventWithTeams` additionally pins the
 * 99-team cap and all-or-nothing atomicity on both backends.
 */

const EVENTS_TABLE = "Events";
const TEAMS_TABLE = "Teams";
const AT = "2026-07-08T12:00:00.000Z";

interface BackendRepos {
  readonly events: EventsRepository;
  readonly teams: TeamsRepository;
}

function makeDdbBackend(): BackendRepos {
  const ddb = makeFakeDdb();
  return {
    events: new DynamoDbEventsRepository(ddb, EVENTS_TABLE, TEAMS_TABLE),
    teams: new DynamoDbTeamsRepository(ddb, TEAMS_TABLE),
  };
}

function makeSqlBackend(): BackendRepos {
  const sql = makeSqliteExecutor();
  return {
    events: new SqlEventsRepository(sql),
    teams: new SqlTeamsRepository(sql),
  };
}

const backends: ReadonlyArray<readonly [string, () => BackendRepos]> = [
  ["DynamoDbEventsRepository", makeDdbBackend],
  ["SqlEventsRepository", makeSqlBackend],
];

function sampleEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    name: "Spring Cup",
    status: "READY",
    problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800, // 2100-01-01, comfortably unexpired
    ...overrides,
  };
}

function sampleTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    teamId: "01TEAMAAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    internalSlug: "alpha",
    teamLoginKey: "KEY-ALPHA",
    awsAccountId: "111111111111",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800,
    ...overrides,
  };
}

describe.each(backends)("EventsRepository mutations parity: %s", (_name, makeRepos) => {
  describe("endEvent", () => {
    it("should end a READY event, stamping endsAt/updatedAt and auto-locking scoring", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.endEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("ENDED");
      expect(stored?.endsAt).toBe(AT);
      expect(stored?.updatedAt).toBe(AT);
      expect(stored?.scoringLocked).toBe(true);
      expect(stored?.scoringLockedAt).toBe(AT);
      expect(stored?.scoringLockedBy).toBe("system:end-event");
      // updated は ALL_NEW / RETURNING の post-image を同梱する (再 read と一致)。
      expect(result.outcome === "updated" && result.event).toEqual(stored);
    });

    it("should return conflict with the probed event when not READY", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "DRAFT" }));

      const result = await events.endEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("conflict");
      expect(result.outcome === "conflict" && result.event?.status).toBe("DRAFT");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("DRAFT");
      expect(stored?.scoringLocked).toBeUndefined();
    });

    it("should return not_found for an absent event", async () => {
      const { events } = makeRepos();
      expect(await events.endEvent("tenant-a", "missing", AT)).toEqual({ outcome: "not_found" });
    });

    it("should return not_found on a tenant mismatch (no cross-tenant write)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.endEvent("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result).toEqual({ outcome: "not_found" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("READY");
    });
  });

  describe("lockScoring", () => {
    it("should lock an unlocked READY event with audit fields", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.lockScoring(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "sub-operator",
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.scoringLocked).toBe(true);
      expect(stored?.scoringLockedAt).toBe(AT);
      expect(stored?.scoringLockedBy).toBe("sub-operator");
      expect(stored?.updatedAt).toBe(AT);
      expect(result.outcome === "updated" && result.event).toEqual(stored);
    });

    it("should lock an ENDED event (awarding phase)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "ENDED" }));

      const result = await events.lockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "sub", AT);

      expect(result.outcome).toBe("updated");
    });

    it("should lock an event whose scoringLocked is explicitly false", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY", scoringLocked: false }));

      const result = await events.lockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "sub", AT);

      expect(result.outcome).toBe("updated");
    });

    it("should return conflict with the probed event when already locked", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY", scoringLocked: true }));

      const result = await events.lockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "sub", AT);

      expect(result.outcome).toBe("conflict");
      expect(result.outcome === "conflict" && result.event?.scoringLocked).toBe(true);
    });

    it("should return conflict when the status is not lockable (DRAFT)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "DRAFT" }));

      const result = await events.lockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "sub", AT);

      expect(result.outcome).toBe("conflict");
      expect(result.outcome === "conflict" && result.event?.status).toBe("DRAFT");
    });

    it("should return not_found for an absent event or a tenant mismatch", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));
      expect(await events.lockScoring("tenant-a", "missing", "sub", AT)).toEqual({
        outcome: "not_found",
      });
      expect(await events.lockScoring("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", "sub", AT)).toEqual(
        { outcome: "not_found" },
      );
    });
  });

  describe("unlockScoring", () => {
    it("should remove the lock and audit fields from a locked event", async () => {
      const { events } = makeRepos();
      await events.putEvent(
        sampleEvent({
          status: "READY",
          scoringLocked: true,
          scoringLockedAt: "2026-06-02T00:00:00.000Z",
          scoringLockedBy: "sub-operator",
        }),
      );

      const result = await events.unlockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.scoringLocked).toBeUndefined();
      expect(stored?.scoringLockedAt).toBeUndefined();
      expect(stored?.scoringLockedBy).toBeUndefined();
      expect(stored?.updatedAt).toBe(AT);
      expect(result.outcome === "updated" && result.event).toEqual(stored);
    });

    it("should return conflict when already unlocked (idempotent no-op)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.unlockScoring("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("conflict");
      expect(result.outcome === "conflict" && result.event?.scoringLocked).toBeUndefined();
    });

    it("should return not_found for an absent event", async () => {
      const { events } = makeRepos();
      expect(await events.unlockScoring("tenant-a", "missing", AT)).toEqual({
        outcome: "not_found",
      });
    });
  });

  describe("archiveEvent", () => {
    it.each([
      "DRAFT",
      "ENDED",
      "TEARDOWN",
    ] as const)("should archive a %s event with archivedAt", async (status) => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status }));

      const result = await events.archiveEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("ARCHIVED");
      expect(stored?.archivedAt).toBe(AT);
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return conflict with the probed event for an in-flight status (READY)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.archiveEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("conflict");
      expect(result.outcome === "conflict" && result.event?.status).toBe("READY");
    });

    it("should return not_found for an absent event or a tenant mismatch", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "DRAFT" }));
      expect(await events.archiveEvent("tenant-a", "missing", AT)).toEqual({
        outcome: "not_found",
      });
      expect(await events.archiveEvent("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", AT)).toEqual({
        outcome: "not_found",
      });
    });
  });

  describe("updateSchedule", () => {
    it("should write every provided field plus updatedAt", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());

      const result = await events.updateSchedule(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        {
          startsAt: "2026-07-09T00:00:00.000Z",
          endsAt: "2026-07-09T06:00:00.000Z",
          teardownAt: "2026-07-09T07:00:00.000Z",
          deployAt: "2026-07-08T23:00:00.000Z",
          scoreboardFreezeMinutes: 30,
        },
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.startsAt).toBe("2026-07-09T00:00:00.000Z");
      expect(stored?.endsAt).toBe("2026-07-09T06:00:00.000Z");
      expect(stored?.teardownAt).toBe("2026-07-09T07:00:00.000Z");
      expect(stored?.deployAt).toBe("2026-07-08T23:00:00.000Z");
      expect(stored?.scoreboardFreezeMinutes).toBe(30);
      expect(stored?.updatedAt).toBe(AT);
      expect(result.outcome === "updated" && result.event).toEqual(stored);
    });

    it("should leave omitted fields untouched (partial patch)", async () => {
      const { events } = makeRepos();
      await events.putEvent(
        sampleEvent({ startsAt: "2026-07-01T00:00:00.000Z", scoreboardFreezeMinutes: 15 }),
      );

      const result = await events.updateSchedule(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        { endsAt: "2026-07-09T06:00:00.000Z" },
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.startsAt).toBe("2026-07-01T00:00:00.000Z");
      expect(stored?.endsAt).toBe("2026-07-09T06:00:00.000Z");
      expect(stored?.scoreboardFreezeMinutes).toBe(15);
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return not_found for an absent event or a tenant mismatch (never conflict)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());
      expect(await events.updateSchedule("tenant-a", "missing", { endsAt: AT }, AT)).toEqual({
        outcome: "not_found",
      });
      expect(
        await events.updateSchedule("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", { endsAt: AT }, AT),
      ).toEqual({ outcome: "not_found" });
    });
  });

  describe("markTeardown", () => {
    it("should mark a non-archived event TEARDOWN", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));

      const result = await events.markTeardown("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("TEARDOWN");
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return conflict for an ARCHIVED event without touching it", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "ARCHIVED" }));

      const result = await events.markTeardown("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result).toEqual({ outcome: "conflict" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("ARCHIVED");
      expect(stored?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("should fold an absent row to conflict (fire-and-forget, no probe)", async () => {
      const { events } = makeRepos();
      expect(await events.markTeardown("tenant-a", "missing", AT)).toEqual({
        outcome: "conflict",
      });
    });
  });

  describe("setProgressionGate", () => {
    const gate = { gateProblemId: "p1", unlockTargetIds: ["p2"] };

    it("should persist the gate config and updatedAt", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());

      const result = await events.setProgressionGate(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        gate,
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.progressionGate).toEqual(gate);
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return not_found for an absent event or a tenant mismatch", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());
      expect(await events.setProgressionGate("tenant-a", "missing", gate, AT)).toEqual({
        outcome: "not_found",
      });
      expect(
        await events.setProgressionGate("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", gate, AT),
      ).toEqual({ outcome: "not_found" });
    });
  });

  describe("clearProgressionGate", () => {
    it("should remove an existing gate and report removed=true", async () => {
      const { events } = makeRepos();
      await events.putEvent(
        sampleEvent({ progressionGate: { gateProblemId: "p1", unlockTargetIds: ["p2"] } }),
      );

      const result = await events.clearProgressionGate(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        AT,
      );

      expect(result).toEqual({ outcome: "updated", removed: true });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.progressionGate).toBeUndefined();
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should report removed=false when no gate was set (idempotent)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());

      const result = await events.clearProgressionGate(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        AT,
      );

      expect(result).toEqual({ outcome: "updated", removed: false });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return not_found for an absent event or a tenant mismatch", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent());
      expect(await events.clearProgressionGate("tenant-a", "missing", AT)).toEqual({
        outcome: "not_found",
      });
      expect(
        await events.clearProgressionGate("tenant-b", "01EVENTAAAAAAAAAAAAAAAAAAA", AT),
      ).toEqual({ outcome: "not_found" });
    });
  });

  describe("markDeploying", () => {
    it.each([
      "DRAFT",
      "READY",
      "DEPLOYING",
    ] as const)("should advance a %s event to DEPLOYING", async (status) => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status }));

      const result = await events.markDeploying("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("DEPLOYING");
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return conflict for a later status (ENDED) without rolling it back", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "ENDED" }));

      const result = await events.markDeploying("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", AT);

      expect(result).toEqual({ outcome: "conflict" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("ENDED");
    });

    it("should fold an absent row to conflict (fire-and-forget, no probe)", async () => {
      const { events } = makeRepos();
      expect(await events.markDeploying("tenant-a", "missing", AT)).toEqual({
        outcome: "conflict",
      });
    });
  });

  describe("transitionStatus", () => {
    it("should apply the CAS when the current status matches `from`", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "DEPLOYING" }));

      const result = await events.transitionStatus(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "DEPLOYING",
        "READY",
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("READY");
      expect(stored?.updatedAt).toBe(AT);
    });

    it("should return conflict when the status moved concurrently (CAS loser skips)", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "ARCHIVED" }));

      const result = await events.transitionStatus(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "TEARDOWN",
        "ARCHIVED",
        AT,
      );

      expect(result).toEqual({ outcome: "conflict" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("should return conflict for an absent row or tenant mismatch without writing", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "READY" }));
      expect(await events.transitionStatus("tenant-a", "missing", "READY", "ENDED", AT)).toEqual({
        outcome: "conflict",
      });
      expect(
        await events.transitionStatus(
          "tenant-b",
          "01EVENTAAAAAAAAAAAAAAAAAAA",
          "READY",
          "ENDED",
          AT,
        ),
      ).toEqual({ outcome: "conflict" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.status).toBe("READY");
    });
  });

  describe("markScheduleFired", () => {
    it("should stamp teardownFiredAt once without touching updatedAt", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "ENDED" }));

      const result = await events.markScheduleFired(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "teardown",
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.teardownFiredAt).toBe(AT);
      // 冪等 audit marker は updatedAt を触らない (旧 recordFired と byte-parity)。
      expect(stored?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("should stamp deployFiredAt for the deploy kind", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ status: "DRAFT" }));

      const result = await events.markScheduleFired(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "deploy",
        AT,
      );

      expect(result.outcome).toBe("updated");
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.deployFiredAt).toBe(AT);
    });

    it("should return conflict when already stamped, keeping the first timestamp", async () => {
      const { events } = makeRepos();
      await events.putEvent(sampleEvent({ teardownFiredAt: "2026-06-05T00:00:00.000Z" }));

      const result = await events.markScheduleFired(
        "tenant-a",
        "01EVENTAAAAAAAAAAAAAAAAAAA",
        "teardown",
        AT,
      );

      expect(result).toEqual({ outcome: "conflict" });
      const stored = await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
      expect(stored?.teardownFiredAt).toBe("2026-06-05T00:00:00.000Z");
    });

    it("should fold an absent row to conflict (idempotent marker, no probe)", async () => {
      const { events } = makeRepos();
      expect(await events.markScheduleFired("tenant-a", "missing", "teardown", AT)).toEqual({
        outcome: "conflict",
      });
    });
  });

  describe("createEventWithTeams", () => {
    it("should create the event and all teams atomically and resolve them by login key", async () => {
      const { events, teams } = makeRepos();
      const event = sampleEvent({ status: "DRAFT" });
      const teamRecords = [
        sampleTeam({ teamId: "01TEAMAAAAAAAAAAAAAAAAAAAA", teamLoginKey: "KEY-ALPHA" }),
        sampleTeam({
          teamId: "01TEAMBBBBBBBBBBBBBBBBBBBB",
          internalSlug: "beta",
          teamLoginKey: "KEY-BETA",
        }),
      ];

      const result = await events.createEventWithTeams(event, teamRecords);

      expect(result).toEqual({ outcome: "created" });
      expect(await events.getEvent("tenant-a", event.eventId)).toEqual(event);
      const listed = await teams.listTeamsByEvent(event.eventId);
      expect(listed.map((t) => t.teamId)).toEqual([
        "01TEAMAAAAAAAAAAAAAAAAAAAA",
        "01TEAMBBBBBBBBBBBBBBBBBBBB",
      ]);
      // participant login: どちらの backend でも同じ plaintext key で引ける。
      expect((await teams.getTeamByLoginKey("KEY-BETA"))?.teamId).toBe(
        "01TEAMBBBBBBBBBBBBBBBBBBBB",
      );
    });

    it("should return conflict and write NOTHING when the event row already exists", async () => {
      const { events, teams } = makeRepos();
      const existing = sampleEvent({ status: "READY" });
      await events.putEvent(existing);

      const result = await events.createEventWithTeams(sampleEvent({ status: "DRAFT" }), [
        sampleTeam(),
      ]);

      expect(result).toEqual({ outcome: "conflict" });
      // 原子性: event は既存のまま、 team は 1 行も書かれない。
      expect((await events.getEvent("tenant-a", existing.eventId))?.status).toBe("READY");
      expect(await teams.listTeamsByEvent(existing.eventId)).toEqual([]);
    });

    it("should return conflict and write NOTHING when a team row already exists (event rolled back)", async () => {
      const { events, teams } = makeRepos();
      await teams.putTeam(sampleTeam());

      const result = await events.createEventWithTeams(sampleEvent({ status: "DRAFT" }), [
        sampleTeam({ internalSlug: "duplicate" }),
      ]);

      expect(result).toEqual({ outcome: "conflict" });
      // 原子性: team 側の衝突でも event 行は書かれない。
      expect(await events.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA")).toBeUndefined();
      expect((await teams.listTeamsByEvent("01EVENTAAAAAAAAAAAAAAAAAAA")).length).toBe(1);
    });

    it("should accept 99 teams (event 1 + 99 = the 100-row atomic write max)", async () => {
      const { events, teams } = makeRepos();
      const teamRecords = Array.from({ length: 99 }, (_, index) =>
        sampleTeam({
          teamId: `01TEAM${String(index).padStart(20, "0")}`,
          internalSlug: `team-${index}`,
          teamLoginKey: `KEY-${index}`,
        }),
      );

      const result = await events.createEventWithTeams(
        sampleEvent({ status: "DRAFT" }),
        teamRecords,
      );

      expect(result).toEqual({ outcome: "created" });
      expect((await teams.listTeamsByEvent("01EVENTAAAAAAAAAAAAAAAAAAA")).length).toBe(99);
    });

    it("should throw on 100 teams (exceeds the 100-row atomic write cap)", async () => {
      const { events } = makeRepos();
      const teamRecords = Array.from({ length: 100 }, (_, index) =>
        sampleTeam({
          teamId: `01TEAM${String(index).padStart(20, "0")}`,
          internalSlug: `team-${index}`,
          teamLoginKey: `KEY-${index}`,
        }),
      );

      await expect(
        events.createEventWithTeams(sampleEvent({ status: "DRAFT" }), teamRecords),
      ).rejects.toThrow(/TransactWrite items > 100/);
    });
  });
});
