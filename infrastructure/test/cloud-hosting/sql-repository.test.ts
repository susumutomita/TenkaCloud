import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import type { InstallationScope } from "../../lib/problem-deploy/control-data/installation-control.js";
import { SqlCloudRepository } from "../../lib/problem-deploy/control-data/sql-cloud-repository.js";
import type { SqlExecutor } from "../../lib/problem-deploy/control-data/sql-port.js";
import {
  sqlChangesGuard,
  sqlCommit,
  sqlConflict,
  sqlGuard,
} from "../../lib/problem-deploy/control-data/sql-transaction.js";
import { sqliteFixture } from "./sql-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const at = "2026-10-01T00:00:00.000Z";
const now = Date.parse(at);
const scope: InstallationScope = {
  account: "123456789012",
  region: "us-east-1",
  environment: "development",
  applicationStackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud/app-id",
  backendStackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy/backend-id",
};
function fixture(path?: string) {
  const f = sqliteFixture(path);
  cleanups.push(f.close);
  const event: EventRecord = {
    eventId: ulid(),
    name: "Fixture",
    status: "DRAFT",
    teamCount: 1,
    problems: [{ problemId: "one", defaultRegion: "us-east-1" }],
    createdAt: at,
    updatedAt: at,
    expiresAt: 1_900_000_000,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "team-one",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: at,
    updatedAt: at,
    expiresAt: event.expiresAt,
  };
  return { ...f, event, team, repository: new SqlCloudRepository(f.sql) };
}

describe("SQL cloud repository with real SQLite transactions", () => {
  it("creates event/team/hash lookup and receipt atomically, with durable replay", async () => {
    const f = fixture();
    const receipt = {
      scope: "organizer",
      key: "create",
      requestHash: "hash",
      response: { eventId: f.event.eventId },
    };
    expect(await f.repository.createEventWithTeams(f.event, [f.team], receipt)).toBe("created");
    expect(await f.repository.getEvent(f.event.eventId)).toEqual(f.event);
    expect(await f.repository.getTeam(f.event.eventId, f.team.teamId)).toEqual(f.team);
    expect(await f.repository.listTeamsByEvent(f.event.eventId)).toEqual([f.team]);
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toEqual(f.team);
    expect(await f.repository.replayEventCreation("organizer", "create", "hash")).toEqual(
      receipt.response,
    );
    await expect(
      f.repository.replayEventCreation("organizer", "create", "changed"),
    ).rejects.toThrow("idempotency_key_reused");
    expect(await f.repository.replayEventCreation("organizer", "absent", "hash")).toBeUndefined();
    expect(JSON.stringify(await f.sql.all("SELECT * FROM cloud_access_keys"))).not.toContain(
      f.team.teamLoginKey,
    );
    const next = { ...f.event, eventId: ulid() };
    expect(
      await f.repository.createEventWithTeams(
        next,
        [{ ...f.team, eventId: next.eventId, teamId: ulid(), teamLoginKey: "B".repeat(43) }],
        receipt,
      ),
    ).toBe("conflict");
    expect(await f.repository.getEvent(next.eventId)).toBeUndefined();
    expect(await f.repository.listTeamsByEvent(next.eventId)).toEqual([]);
  });
  it("rolls back every new record on a key collision in another event", async () => {
    const f = fixture();
    await f.repository.createEventWithTeams(f.event, [f.team]);
    const next = { ...f.event, eventId: ulid() };
    expect(
      await f.repository.createEventWithTeams(next, [
        { ...f.team, eventId: next.eventId, teamId: ulid() },
      ]),
    ).toBe("conflict");
    expect(await f.repository.getEvent(next.eventId)).toBeUndefined();
    expect(await f.repository.listTeamsByEvent(next.eventId)).toEqual([]);
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toEqual(f.team);
  });
  it("rejects invalid rosters before any write", async () => {
    const f = fixture();
    for (const teams of [
      [],
      [{ ...f.team, eventId: ulid() }],
      [f.team, f.team],
      [{ ...f.team, teamLoginKey: "invalid" }],
    ]) {
      await expect(
        f.repository.createEventWithTeams({ ...f.event, teamCount: teams.length }, teams),
      ).rejects.toThrow();
    }
    const teams = Array.from({ length: 100 }, () => ({ ...f.team, teamId: ulid() }));
    await expect(
      f.repository.createEventWithTeams({ ...f.event, teamCount: 100 }, teams),
    ).rejects.toThrow("1-99");
    expect(await f.repository.listEvents()).toEqual([]);
  });
  it("rotates and revokes with CAS; a stale writer cannot delete the winning access key", async () => {
    const f = fixture();
    await f.repository.createEventWithTeams(f.event, [f.team]);
    expect(await f.repository.rotateTeamAccess(f.team, "B".repeat(43), at)).toBe("updated");
    expect(await f.repository.rotateTeamAccess(f.team, "C".repeat(43), at)).toBe("conflict");
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toBeUndefined();
    const rotated = await f.repository.authenticateTeam("B".repeat(43), now);
    expect(rotated?.authVersion).toBe(2);
    expect(await f.repository.authenticateTeam("C".repeat(43), now)).toBeUndefined();
    if (!rotated) throw new Error("Missing rotated team");
    expect(await f.repository.rotateTeamAccess(rotated, undefined, at)).toBe("updated");
    expect(await f.repository.authenticateTeam("B".repeat(43), now)).toBeUndefined();
    const revoked = await f.repository.getTeam(f.team.eventId, f.team.teamId);
    expect(revoked).toMatchObject({ authVersion: 3, accessRevoked: true });
    if (!revoked) throw new Error("Missing revoked team");
    expect(await f.repository.rotateTeamAccess(revoked, "D".repeat(43), at)).toBe("updated");
    expect(await f.repository.authenticateTeam("D".repeat(43), now)).toMatchObject({
      authVersion: 4,
    });
  });
  it("rolls back a rotation if its replacement key belongs to another team", async () => {
    const f = fixture();
    const other = {
      ...f.team,
      teamId: ulid(),
      internalSlug: "other",
      teamLoginKey: "B".repeat(43),
    };
    await f.repository.createEventWithTeams({ ...f.event, teamCount: 2 }, [f.team, other]);
    expect(await f.repository.rotateTeamAccess(f.team, other.teamLoginKey, at)).toBe("conflict");
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toEqual(f.team);
    expect(await f.repository.authenticateTeam(other.teamLoginKey, now)).toEqual(other);
    await expect(f.repository.rotateTeamAccess(f.team, f.team.teamLoginKey, at)).rejects.toThrow(
      "must be new",
    );
    await expect(f.repository.rotateTeamAccess(f.team, "invalid", at)).rejects.toThrow();
  });
  it.each([
    { accessRevoked: true },
    { authVersion: 2 },
    { teamLoginKey: "B".repeat(43) },
    { expiresAt: 1 },
  ])("rejects stale/revoked/expired team metadata: %j", async (change) => {
    const f = fixture();
    await f.repository.createEventWithTeams(f.event, [f.team]);
    await f.sql.run("UPDATE cloud_teams SET payload = ?", [
      JSON.stringify({ ...f.team, ...change }),
    ]);
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toBeUndefined();
  });
  it.each([{ status: "ARCHIVED" }, { status: "TEARDOWN" }, { expiresAt: Math.floor(now / 1000) }])(
    "rejects closed or expired events: %j",
    async (change) => {
      const f = fixture();
      await f.repository.createEventWithTeams(f.event, [f.team]);
      await f.sql.run("UPDATE cloud_events SET payload = ?", [
        JSON.stringify({ ...f.event, ...change }),
      ]);
      expect(await f.repository.authenticateTeam(f.team.teamLoginKey, now)).toBeUndefined();
    },
  );
  it("rejects corrupt payload scopes and malformed lookup metadata", async () => {
    const f = fixture();
    await f.repository.createEventWithTeams(f.event, [f.team]);
    expect(await f.repository.authenticateTeam("invalid", now)).toBeUndefined();
    expect(await f.repository.authenticateTeam("Z".repeat(43), now)).toBeUndefined();
    await f.sql.run("UPDATE cloud_events SET payload = ?", [
      JSON.stringify({ ...f.event, eventId: ulid() }),
    ]);
    await expect(f.repository.getEvent(f.event.eventId)).rejects.toThrow("scope mismatch");
    await f.sql.run("UPDATE cloud_teams SET payload = ?", [
      JSON.stringify({ ...f.team, teamId: ulid() }),
    ]);
    await expect(f.repository.getTeam(f.event.eventId, f.team.teamId)).rejects.toThrow(
      "scope mismatch",
    );
    await f.sql.run("UPDATE cloud_access_keys SET auth_version = 0");
    await expect(f.repository.authenticateTeam(f.team.teamLoginKey, now)).rejects.toThrow();
  });
  it("lists current deployments and score projections only in their event and team", async () => {
    const f = fixture();
    const otherTeam = ulid();
    const otherEvent = ulid();
    for (const [eventId, teamId] of [
      [f.event.eventId, f.team.teamId],
      [f.event.eventId, otherTeam],
      [otherEvent, ulid()],
    ] as const) {
      const job = {
        jobId: ulid(),
        eventId,
        teamId,
        problemId: "one",
        region: "us-east-1",
        awsAccountId: "123456789012",
        status: "COMPLETE",
        expiresAt: f.event.expiresAt,
        score: 10,
      };
      await f.sql.run("INSERT INTO cloud_deployments VALUES (?, ?, ?, ?, ?)", [
        job.jobId,
        eventId,
        teamId,
        job.problemId,
        JSON.stringify(job),
      ]);
      await f.sql.run("INSERT INTO cloud_team_scores VALUES (?, ?, ?)", [
        eventId,
        teamId,
        JSON.stringify({ eventId, teamId, score: 10, completedProblems: 1 }),
      ]);
    }
    expect(await f.repository.listDeploymentsByTeam(f.event.eventId, f.team.teamId)).toHaveLength(
      1,
    );
    expect(await f.repository.listDeploymentsByEvent(f.event.eventId)).toHaveLength(2);
    expect(await f.repository.listTeamScores(f.event.eventId)).toHaveLength(2);
    await f.sql.run("UPDATE cloud_team_scores SET payload = ? WHERE event_id = ?", [
      JSON.stringify({ eventId: otherEvent, teamId: otherTeam, score: 0, completedProblems: 0 }),
      f.event.eventId,
    ]);
    await expect(f.repository.listTeamScores(f.event.eventId)).rejects.toThrow("scope mismatch");
  });
  it("orders event listing by creation time and event ID descending", async () => {
    const f = fixture();
    await f.repository.createEventWithTeams(f.event, [f.team]);
    const newer = { ...f.event, eventId: ulid(), createdAt: "2026-10-02T00:00:00.000Z" };
    await f.repository.createEventWithTeams(newer, [
      { ...f.team, eventId: newer.eventId, teamId: ulid(), teamLoginKey: "B".repeat(43) },
    ]);
    expect(await f.repository.listEvents()).toEqual([newer, f.event]);
  });
});

describe("SQL atomic guard and durable installation fence", () => {
  it("rolls back writes both before and after a failed CAS or predicate", async () => {
    const f = fixture();
    for (const guard of [sqlGuard("0"), sqlChangesGuard()]) {
      expect(
        await sqlCommit(f.sql, [
          {
            sql: "INSERT INTO cloud_events VALUES (?, ?)",
            params: [f.event.eventId, JSON.stringify(f.event)],
          },
          { sql: "UPDATE cloud_teams SET payload = '{}' WHERE team_id = 'absent'" },
          guard,
          {
            sql: "INSERT INTO cloud_teams VALUES (?, ?, ?)",
            params: [f.event.eventId, f.team.teamId, JSON.stringify(f.team)],
          },
        ]),
      ).toBe(false);
      expect(await f.repository.listEvents()).toEqual([]);
      expect(await f.repository.listTeamsByEvent(f.event.eventId)).toEqual([]);
    }
  });
  it("classifies only known unique and named conditional failures", async () => {
    const f = fixture();
    for (const diagnostic of [
      "CHECK constraint failed: cloud_cas_guard",
      "UNIQUE constraint failed: cloud_events.event_id",
      "UNIQUE constraint failed: cloud_teams.event_id, cloud_teams.team_id",
    ]) {
      expect(
        sqlConflict(
          Object.assign(
            new Error(
              `PROXY_ERROR: PROXY_ERROR: error executing a request on the primary: ${diagnostic}`,
            ),
            { code: "PROXY_ERROR" },
          ),
        ),
      ).toBe(true);
    }
    for (const error of [
      new Error("network SQLITE_CONSTRAINT_UNIQUE"),
      Object.assign(new Error("timeout"), { code: "TIMEOUT" }),
      Object.assign(new Error("CHECK constraint failed: other"), {
        code: "SQLITE_CONSTRAINT_CHECK",
      }),
      Object.assign(new Error("CHECK constraint failed: cloud_cas_guard"), { code: "PROXY_ERROR" }),
      Object.assign(new Error("PROXY_ERROR: error executing a request on the primary: timeout"), {
        code: "PROXY_ERROR",
      }),
      Object.assign(
        new Error(
          "PROXY_ERROR: error executing a request on the primary: CHECK constraint failed: other",
        ),
        {
          code: "PROXY_ERROR",
        },
      ),
      Object.assign(
        new Error(
          "PROXY_ERROR: error executing a request on the primary: UNIQUE constraint failed: unrelated.key",
        ),
        {
          code: "PROXY_ERROR",
        },
      ),
      Object.assign(
        new Error(
          "PROXY_ERROR: error executing a request on the primary: CHECK constraint failed: cloud_cas_guard",
        ),
        {
          code: "TIMEOUT",
        },
      ),
    ]) {
      expect(sqlConflict(error)).toBe(false);
      const failing: SqlExecutor = {
        ...f.sql,
        batch: () => {
          throw error;
        },
      };
      await expect(
        new SqlCloudRepository(failing).createEventWithTeams(f.event, [f.team]),
      ).rejects.toBe(error);
    }
  });
  it("keeps stop intent and scopes across connection restart, and fences future creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-turso-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "control.db");
    const f = fixture(path);
    await f.repository.createEventWithTeams(f.event, [f.team]);
    const control = await f.repository.stopAcceptingInstallation(scope, at);
    const reopened = fixture(path);
    expect(
      await reopened.repository.stopAcceptingInstallation(scope, "2026-10-02T00:00:00.000Z"),
    ).toEqual(control);
    expect(await reopened.repository.listStoppedInstallationEvents(scope)).toEqual([f.event]);
    await expect(
      reopened.repository.createEventWithTeams(reopened.event, [reopened.team]),
    ).rejects.toThrow("installation_draining");
    expect(await reopened.repository.getEvent(reopened.event.eventId)).toBeUndefined();
    await expect(
      reopened.repository.stopAcceptingInstallation(
        { ...scope, applicationStackId: scope.applicationStackId.replace("app-id", "changed-id") },
        at,
      ),
    ).rejects.toThrow("scope_changed");
    await expect(reopened.repository.confirmInstallationDrained(scope, at)).rejects.toThrow(
      "events_not_drained",
    );
    await f.sql.run("UPDATE cloud_events SET payload = ?", [
      JSON.stringify({ ...f.event, status: "ARCHIVED", teardownExpected: 0, teardownCompleted: 0 }),
    ]);
    await reopened.repository.confirmInstallationDrained(scope, at);
    await reopened.repository.confirmInstallationDrained(scope, at);
    expect(await reopened.repository.installationControl()).toMatchObject({ status: "DRAINED" });
    await expect(reopened.repository.assertAcceptingInstallation()).rejects.toThrow(
      "installation_draining",
    );
  });
  it("requires a valid stop scope and checks every archived event counter", async () => {
    const f = fixture();
    await expect(f.repository.listStoppedInstallationEvents(scope)).rejects.toThrow("not_stopped");
    await f.repository.createEventWithTeams(f.event, [f.team]);
    await f.repository.stopAcceptingInstallation(scope, at);
    for (const change of [
      { status: "ARCHIVED" },
      { status: "ARCHIVED", teardownExpected: 2, teardownCompleted: 1 },
      { status: "TEARDOWN", teardownExpected: 0, teardownCompleted: 0 },
    ]) {
      await f.sql.run("UPDATE cloud_events SET payload = ?", [
        JSON.stringify({ ...f.event, ...change }),
      ]);
      await expect(f.repository.confirmInstallationDrained(scope, at)).rejects.toThrow(
        "events_not_drained",
      );
    }
    const control = await f.repository.installationControl();
    await f.sql.run("UPDATE cloud_installation_control SET payload = ?", [
      JSON.stringify({ ...control, scopeDigest: "a".repeat(64) }),
    ]);
    await expect(f.repository.installationControl()).rejects.toThrow("scope_corrupt");
  });
});
