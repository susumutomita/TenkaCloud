import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentRecord } from "../../../lib/problem-deploy/control-data/domain/deployments";
import type { EventRecord } from "../../../lib/problem-deploy/control-data/domain/events";
import { SqlEventsRepository } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { SqlTeamsRepository } from "../../../lib/problem-deploy/control-data/sql-teams-repository";
import {
  claimRegistration,
  configureRegistration,
  inspectRegistration,
  type RegistrationDeps,
  registrationDigest,
  registrationStatus,
  registrationSummary,
} from "../../../lib/problem-deploy/handlers/shared/event-registration";
import { makeSqliteExecutor } from "../control-data/control-data-write.test-helpers";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture is missing");
  return value;
}

const now = Date.parse("2026-09-22T09:00:00.000Z");
const event: EventRecord = {
  eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
  tenantId: "tenant-a",
  name: "Beginner Battle",
  status: "READY",
  problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
  teamCount: 2,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  endsAt: "2026-09-23T00:00:00.000Z",
  expiresAt: Math.floor(now / 1000) + 172800,
};
const receipt = (n: number) => `${n}`.padStart(43, "r");
let deps: RegistrationDeps;
let events: SqlEventsRepository;
let teams: SqlTeamsRepository;
let jobs: DeploymentRecord[];
let invite: string;

async function open(teamIds = ["team-1", "team-2"]) {
  const result = await configureRegistration(
    deps,
    event.tenantId,
    event.eventId,
    {
      enabled: true,
      teamIds,
      closesAt: "2026-09-22T23:00:00.000Z",
    },
    now,
  );
  if (!("invitation" in result) || !result.invitation) throw new Error("missing invitation");
  return result.invitation;
}
async function claim(n: number) {
  return claimRegistration(deps, event.tenantId, event.eventId, invite, receipt(n), now);
}
async function status(n: number) {
  return registrationStatus(deps, event.tenantId, event.eventId, receipt(n), now);
}

beforeEach(async () => {
  const sql = makeSqliteExecutor();
  events = new SqlEventsRepository(sql);
  teams = new SqlTeamsRepository(sql);
  await events.putEvent(event);
  jobs = [];
  for (let n = 1; n <= 2; n++) {
    const teamId = `team-${n}`;
    await teams.putTeam({
      tenantId: event.tenantId,
      eventId: event.eventId,
      teamId,
      internalSlug: teamId,
      teamLoginKey: `${n}`.repeat(43),
      awsAccountId: `${n}`.repeat(12),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      expiresAt: event.expiresAt,
    });
    jobs.push({
      tenantId: event.tenantId,
      eventId: event.eventId,
      teamId,
      problemId: "p1",
      jobId: `job-${n}`,
      status: "COMPLETE",
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      expiresAt: event.expiresAt,
      awsAccountId: `${n}`.repeat(12),
      region: "ap-northeast-1",
      teamName: teamId,
      teamLoginKey: `${n}`.repeat(43),
      namePrefix: teamId,
    });
  }
  deps = {
    events,
    teams,
    deployments: {
      listByTenantAndEvent: vi.fn(async () => jobs),
      listByTeamLoginKey: vi.fn(async (key) => jobs.filter((job) => job.teamLoginKey === key)),
    },
  };
  invite = await open();
});

describe("self-registration with real SQLite repositories", () => {
  it("atomically allocates different slots, caps capacity and resumes the same receipt", async () => {
    vi.mocked(deps.deployments.listByTenantAndEvent).mockClear();
    const [a, b] = await Promise.all([claim(1), claim(2)]);
    expect(new Set([a.teamId, b.teamId]).size).toBe(2);
    expect(await claim(1)).toEqual(a);
    await expect(claim(3)).rejects.toThrow("full");
    expect(
      await inspectRegistration(deps, event.tenantId, event.eventId, invite, now),
    ).toMatchObject({ state: "full", remaining: 0 });
    const stored = await events.getEvent(event.tenantId, event.eventId);
    expect(stored?.registration?.claims).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(receipt(1));
    expect(JSON.stringify(stored)).not.toContain(invite);
    expect(stored?.registration?.invitationHash).toBe(registrationDigest(invite));
    if (!stored) throw new Error("Event missing after claims");
    const summary = registrationSummary(stored, now);
    expect(new Set(summary.claimedTeamIds)).toEqual(new Set([a.teamId, b.teamId]));
    expect(JSON.stringify(summary)).not.toMatch(/invitation|receipt|Hash/);
    expect(deps.deployments.listByTenantAndEvent).not.toHaveBeenCalled();
    expect(deps.deployments.listByTeamLoginKey).toHaveBeenCalledWith("1".repeat(43));
    expect(deps.deployments.listByTeamLoginKey).toHaveBeenCalledWith("2".repeat(43));
  });

  it("simultaneous retries with one receipt reserve only one slot", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(1)));
    expect(new Set(results.map((result) => result.teamId)).size).toBe(1);
    expect(
      (await events.getEvent(event.tenantId, event.eventId))?.registration?.claims,
    ).toHaveLength(1);
  });

  it("returns no login credential while preparing or failed, and honors the newest retry", async () => {
    jobs[0] = { ...present(jobs[0]), status: "IN_PROGRESS" };
    expect(await claim(1)).toEqual({
      eventName: event.name,
      teamId: "team-1",
      state: "preparing",
      ready: 0,
      total: 1,
    });
    jobs[0] = { ...present(jobs[0]), status: "FAILED" };
    expect(await status(1)).toMatchObject({ state: "failed" });
    expect(await status(1)).not.toHaveProperty("teamLoginKey");
    jobs.push({
      ...present(jobs[0]),
      jobId: "retry",
      status: "COMPLETE",
      createdAt: "2026-09-22T09:01:00.000Z",
    });
    expect(await status(1)).toMatchObject({ state: "ready", teamLoginKey: "1".repeat(43) });
  });

  it.each([
    "IN_PROGRESS",
    "FAILED",
  ] as const)("withholds the login key when a newer %s retry follows a completed deployment", async (retryStatus) => {
    expect(await claim(1)).toHaveProperty("teamLoginKey");
    jobs.push({
      ...present(jobs[0]),
      jobId: "newer-retry",
      status: retryStatus,
      createdAt: "2026-09-22T09:01:00.000Z",
    });
    const progress = await status(1);
    expect(progress).toMatchObject({
      state: retryStatus === "FAILED" ? "failed" : "preparing",
      ready: 0,
      total: 1,
    });
    expect(progress).not.toHaveProperty("teamLoginKey");
  });

  it("stops new claims on closing or link rotation but existing receipts resume", async () => {
    const allocated = await claim(1);
    await configureRegistration(deps, event.tenantId, event.eventId, { enabled: false }, now);
    await expect(claim(2)).rejects.toThrow("closed");
    expect(await status(1)).toEqual(allocated);
    const rotated = await open();
    expect(rotated).not.toBe(invite);
    await expect(claim(2)).rejects.toThrow("not_found");
    expect(await status(1)).toEqual(allocated);
    invite = rotated;
    expect((await claim(2)).teamId).toBe("team-2");
  });

  it("does not release credentials for a deployment in the team's former account", async () => {
    await claim(1);
    const first = present(await teams.getTeam(event.tenantId, event.eventId, "team-1"));
    await teams.putTeam({ ...first, awsAccountId: "3".repeat(12) });
    const pending = await status(1);
    expect(pending).toMatchObject({ state: "failed", ready: 0 });
    expect(pending).not.toHaveProperty("teamLoginKey");
  });

  it("rejects unknown invitations, receipts and other tenants without disclosing event data", async () => {
    await expect(
      inspectRegistration(deps, event.tenantId, event.eventId, receipt(4), now),
    ).rejects.toThrow("not_found");
    await expect(inspectRegistration(deps, "tenant-b", event.eventId, invite, now)).rejects.toThrow(
      "not_found",
    );
    await expect(status(5)).rejects.toThrow("not_found");
    expect(
      (await events.getEvent(event.tenantId, event.eventId))?.registration?.claims,
    ).toHaveLength(0);
  });

  it("does not allocate or release credentials after event end or expiry", async () => {
    await claim(1);
    await events.putEvent({
      ...present(await events.getEvent(event.tenantId, event.eventId)),
      status: "ENDED",
    });
    await expect(claim(2)).rejects.toThrow("closed");
    await expect(status(1)).rejects.toThrow("closed");
  });

  it("requires an explicit prepared pool with distinct accounts", async () => {
    await expect(open([])).rejects.toThrow("invalid_pool");
    await expect(open(["team-1", "team-1"])).rejects.toThrow("invalid_pool");
    await expect(open(["missing"])).rejects.toThrow("invalid_pool");
    const second = present(await teams.getTeam(event.tenantId, event.eventId, "team-2"));
    await teams.putTeam({ ...second, awsAccountId: "1".repeat(12) });
    await expect(open()).rejects.toThrow("invalid_pool");
    await teams.putTeam(second);
    jobs = [];
    await expect(open()).rejects.toThrow("not_ready");
  });

  it("cannot remove an allocated slot or open beyond event end", async () => {
    await claim(1);
    await expect(open(["team-2"])).rejects.toThrow("invalid_pool");
    await expect(
      configureRegistration(
        deps,
        event.tenantId,
        event.eventId,
        {
          enabled: true,
          teamIds: ["team-1"],
          closesAt: "2026-09-24T00:00:00.000Z",
        },
        now,
      ),
    ).rejects.toThrow("invalid_pool");
  });

  it("closes at the advertised deadline while keeping an allocated receipt usable", async () => {
    await claim(1);
    const deadline = Date.parse("2026-09-22T23:00:00.000Z");
    const current = present(await events.getEvent(event.tenantId, event.eventId));
    expect(registrationSummary(current, deadline - 1).enabled).toBe(true);
    expect(registrationSummary(current, deadline).enabled).toBe(false);
    expect(
      await inspectRegistration(deps, event.tenantId, event.eventId, invite, deadline),
    ).toMatchObject({ state: "closed" });
    await expect(
      claimRegistration(deps, event.tenantId, event.eventId, invite, receipt(2), deadline),
    ).rejects.toThrow("closed");
    expect(
      await registrationStatus(deps, event.tenantId, event.eventId, receipt(1), deadline),
    ).toMatchObject({ state: "ready" });
  });

  it("does not offer expired team credentials in a new pool", async () => {
    const first = present(await teams.getTeam(event.tenantId, event.eventId, "team-1"));
    await teams.putTeam({ ...first, expiresAt: Math.floor(now / 1000) });
    await expect(open()).rejects.toThrow("invalid_pool");
  });

  it("CAS refuses a stale version, a different tenant, and a concurrently ended event", async () => {
    const current = present(await events.getEvent(event.tenantId, event.eventId));
    const input = {
      tenantId: event.tenantId,
      eventId: event.eventId,
      expectedVersion: 0,
      registration: present(current.registration),
      now: new Date(now).toISOString(),
    };
    expect(await events.updateRegistration(input)).toBe("conflict");
    expect(
      await events.updateRegistration({ ...input, expectedVersion: 1, tenantId: "tenant-b" }),
    ).toBe("conflict");
    await events.putEvent({ ...current, endsAt: new Date(now - 1).toISOString() });
    expect(await events.updateRegistration({ ...input, expectedVersion: 1 })).toBe("conflict");
  });

  it("surfaces persistence failure without an empty or successful allocation", async () => {
    vi.spyOn(events, "updateRegistration").mockRejectedValue(new Error("storage offline"));
    await expect(claim(1)).rejects.toThrow("storage offline");
  });
});
