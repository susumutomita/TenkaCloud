import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { build } from "esbuild";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostPlugin } from "../../../scripts/local-host/coordination-core.js";
import { hash, jsonBytes } from "../../lib/problem-deploy/control-data/coordination-state.js";
import {
  SQL_COORDINATION_MAX_BYTES as COORDINATION_MAX_BYTES,
  type NativeCoordinationArtifact,
} from "../../lib/problem-deploy/control-data/domain/coordination.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import { sqlCoordinationClosedGuard } from "../../lib/problem-deploy/control-data/sql-coordination-schema.js";
import { SqlDeploymentWork } from "../../lib/problem-deploy/control-data/sql-deployment-work.js";
import { SqlDeploymentsCoordination } from "../../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import type { SqlExecutor, SqlStatement } from "../../lib/problem-deploy/control-data/sql-port.js";
import { sqlCommit } from "../../lib/problem-deploy/control-data/sql-transaction.js";
import { sqliteFixture } from "./sql-fixture.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
type Engine = "sqlite" | "libsql";
interface State {
  padding: string;
  scores: Record<string, number>;
}
const operation = (key = "operation-one", op: unknown = { kind: "score" }) => ({
  key,
  hash: hash(JSON.stringify(op)),
  op,
});
const publication = (writes: readonly SqlStatement[]) =>
  writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ?"));
async function connection(engine: Engine, path: string): Promise<SqlExecutor> {
  if (engine === "sqlite") {
    const fixture = sqliteFixture(path);
    cleanups.push(fixture.close);
    return fixture.sql;
  }
  const client = createClient({ url: `file:${path}` });
  cleanups.push(() => client.close());
  await initializeControlDataSchema(client);
  return new LibsqlExecutor(client);
}
async function fixture(engine: Engine, count = 2, padding = 0) {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-native-sql-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "native.db");
  const base = await connection(engine, path);
  const peer = await connection(engine, path);
  let beforeBatch: ((writes: readonly SqlStatement[]) => void | Promise<void>) | undefined;
  let afterBatch: ((writes: readonly SqlStatement[]) => void | Promise<void>) | undefined;
  const sql: SqlExecutor = {
    ...base,
    run: base.run.bind(base),
    get: base.get.bind(base),
    all: base.all.bind(base),
    batch: async (writes) => {
      await beforeBatch?.(writes);
      const result = await base.batch(writes);
      await afterBatch?.(writes);
      return result;
    },
  };
  const event: EventRecord = {
    eventId: ulid(NOW),
    name: "Native SQL fixture",
    status: "READY",
    teamCount: count,
    problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
    createdAt: AT,
    updatedAt: AT,
    startsAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const teams: TeamRecord[] = Array.from({ length: count }, (_, index) => ({
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: `team-${index}`,
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  }));
  const team = teams[0];
  if (!team) throw new Error("Missing fixture team");
  const apply = vi.fn((state: unknown, _team: string, op: unknown) => {
    const old = state as State;
    return {
      padding: (op as { kind: string }).kind === "shrink" ? "" : old.padding,
      scores: Object.fromEntries(Object.entries(old.scores).map(([id, score]) => [id, score + 1])),
    };
  });
  const plugin: HostPlugin = {
    initialState: (ctx) => ({
      padding: "x".repeat(padding),
      scores: Object.fromEntries(ctx.teamIds.map((id) => [id, 0])),
    }),
    validateOp: (_state, _team, op) =>
      (op as { kind: string }).kind === "reject" ? { ok: false, error: "rejected" } : { ok: true },
    applyOp: apply,
    projectForTeam: (state, id) => ({ score: (state as State).scores[id] }),
    teamScores: (state) => (state as State).scores,
    tickOnRequest: true,
    tick: (state) => state,
  };
  const artifactDigest = hash("sql-native-fixture");
  const artifact: NativeCoordinationArtifact = {
    problemId: "ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${hash("fixture-catalog")}.json`,
    stateBudget: { baseBytes: 1536, bytesPerTeam: 31744 },
    plugin,
  };
  await base.run("INSERT INTO cloud_events (event_id, payload) VALUES (?, ?)", [
    event.eventId,
    JSON.stringify(event),
  ]);
  for (const value of teams)
    await base.run("INSERT INTO cloud_teams (event_id, team_id, payload) VALUES (?, ?, ?)", [
      event.eventId,
      value.teamId,
      JSON.stringify(value),
    ]);
  const store = new SqlDeploymentsCoordination(sql);
  return {
    sql,
    peer,
    store,
    event,
    teams,
    team,
    artifact,
    apply,
    initialize: () => store.initialize({ event, teams, artifact, now: NOW }),
    request: (op = operation()) =>
      store.request({ event, team, artifact, now: () => NOW, operation: op }),
    read: () => store.read(event.eventId, artifact.problemId),
    count: async (table: string) =>
      (await base.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count,
    before: (hook: typeof beforeBatch) => {
      beforeBatch = hook;
    },
    after: (hook: typeof afterBatch) => {
      afterBatch = hook;
    },
  };
}

for (const engine of ["sqlite", "libsql"] as const)
  describe(`${engine}: native coordination atomic storage`, () => {
    it("initializes once and persists run identity, secret, pin, schema and roster", async () => {
      const f = await fixture(engine);
      const [first, second] = await Promise.all([f.initialize(), f.initialize()]);
      expect(second).toMatchObject({
        runId: first.runId,
        match: { matchSecret: first.match.matchSecret },
      });
      expect(await f.read()).toMatchObject(first);
      const other = new SqlDeploymentsCoordination(f.peer);
      expect(await other.read(f.event.eventId, f.artifact.problemId)).toMatchObject(first);
      await expect(
        f.store.initialize({
          event: f.event,
          teams: f.teams,
          artifact: {
            ...f.artifact,
            artifactDigest: hash("different"),
            pluginKey: `plugins/${hash("different")}.mjs`,
          },
          now: NOW,
        }),
      ).rejects.toThrow("coordination_artifact_changed");
      await expect(
        f.store.initialize({
          event: f.event,
          teams: [{ ...f.team, teamId: ulid() }, f.teams[1] as TeamRecord],
          artifact: f.artifact,
          now: NOW,
        }),
      ).rejects.toThrow("coordination_roster_changed");
    });
    it("atomically publishes state, team scores, score history and an immutable replay receipt", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.peer.run("INSERT INTO cloud_team_scores VALUES (?, ?, ?)", [
        f.event.eventId,
        f.team.teamId,
        JSON.stringify({
          eventId: f.event.eventId,
          teamId: f.team.teamId,
          score: 10,
          completedProblems: 2,
        }),
      ]);
      const response = await f.request();
      expect(response).toEqual({ status: 200, body: { projection: { score: 1 } }, revision: 1 });
      const reloaded = new SqlDeploymentsCoordination(f.peer);
      expect(
        await reloaded.request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW,
          operation: operation(),
        }),
      ).toEqual(response);
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(
          String(
            (
              await f.peer.get("SELECT payload FROM cloud_team_scores WHERE team_id = ?", [
                f.team.teamId,
              ])
            )?.payload,
          ),
        ),
      ).toMatchObject({ score: 11, completedProblems: 2 });
      expect(
        await f.store.listScoreEvents(f.event.eventId, f.artifact.problemId, f.team.teamId),
      ).toEqual([
        {
          jobId: (await f.read())?.runId,
          problemId: f.artifact.problemId,
          points: 1,
          source: "coordination",
          result: "ok",
          occurredAt: AT,
        },
      ]);
      await expect(f.request(operation("operation-one", { kind: "different" }))).rejects.toThrow(
        "idempotency_key_reused",
      );
      expect(await f.count("cloud_coordination_receipts")).toBe(1);
    });
    it("rolls back snapshot and scores when receipt insertion fails", async () => {
      const f = await fixture(engine);
      const initial = await f.initialize();
      await f.peer.run(
        "CREATE TRIGGER reject_native_receipt BEFORE INSERT ON cloud_coordination_receipts BEGIN SELECT RAISE(ABORT, 'receipt_unavailable'); END",
      );
      await expect(f.request()).rejects.toThrow("receipt_unavailable");
      expect(await f.read()).toMatchObject({
        runId: initial.runId,
        revision: 0,
        match: initial.match,
      });
      expect(await f.count("cloud_team_scores")).toBe(0);
      expect(await f.count("cloud_coordination_scores")).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
      const row = await f.peer.get("SELECT payload FROM cloud_coordination_runs");
      expect(String(row?.payload)).not.toContain("admissionOwner");
    });
    it.each(["authVersion", "accessRevoked", "expiresAt"])(
      "reevaluates team %s inside the publication transaction",
      async (field) => {
        const f = await fixture(engine);
        await f.initialize();
        f.before(async (writes) => {
          if (!publication(writes)) return;
          f.before(undefined);
          const value = { accessRevoked: true, expiresAt: 1, authVersion: 2 }[field];
          await f.peer.run("UPDATE cloud_teams SET payload = ? WHERE team_id = ?", [
            JSON.stringify({ ...f.team, [field]: value }),
            f.team.teamId,
          ]);
        });
        await expect(f.request()).rejects.toThrow("unauthorized");
        expect((await f.read())?.revision).toBe(0);
        expect(await f.count("cloud_team_scores")).toBe(0);
        expect(await f.count("cloud_coordination_receipts")).toBe(0);
      },
    );
    it.each(["lock", "close", "expiry"])(
      "fences stale reducer output when the event changes: %s",
      async (change) => {
        const f = await fixture(engine);
        await f.initialize();
        f.before(async (writes) => {
          if (!publication(writes)) return;
          f.before(undefined);
          await f.peer.run("UPDATE cloud_events SET payload = ?", [
            JSON.stringify({
              ...f.event,
              updatedAt: new Date(NOW + 1).toISOString(),
              ...{
                lock: { scoringLocked: true },
                close: { status: "ENDED" },
                expiry: { expiresAt: 1 },
              }[change],
            }),
          ]);
        });
        await expect(f.request()).rejects.toThrow("event_changed");
        expect((await f.read())?.revision).toBe(0);
        expect(await f.count("cloud_team_scores")).toBe(0);
        expect(await f.count("cloud_coordination_receipts")).toBe(0);
      },
    );
    it("retries a stolen revision without overwriting the winning state or receipt", async () => {
      const f = await fixture(engine);
      await f.initialize();
      let otherResponse: unknown;
      f.before(async (writes) => {
        if (!publication(writes)) return;
        f.before(undefined);
        await f.peer.run(
          "UPDATE cloud_coordination_runs SET payload = json_remove(payload, '$.admissionOwner', '$.admissionExpiresAt')",
        );
        otherResponse = await new SqlDeploymentsCoordination(f.peer).request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW,
          operation: operation("winning-operation"),
        });
      });
      const response = await f.request();
      expect(otherResponse).toMatchObject({ revision: 1 });
      expect(response).toMatchObject({ revision: 2, body: { projection: { score: 2 } } });
      expect((await f.read())?.match.scores[f.team.teamId]).toBe(2);
      expect(await f.count("cloud_coordination_receipts")).toBe(2);
    });
    it("timestamps admission after encoding and rejects publication after lease expiry", async () => {
      const f = await fixture(engine);
      await f.initialize();
      let now = NOW;
      const store = new SqlDeploymentsCoordination(f.sql, (sample) => {
        if (sample.phase === "encode") now += 6000;
      });
      // Every attempted result takes longer than its lease. No score or receipt may escape.
      const failure = new Error("stop-after-expired-ownership");
      let publications = 0;
      f.after((writes) => {
        if (publication(writes)) throw new Error("Expired lease published");
      });
      f.before((writes) => {
        if (publication(writes) && ++publications === 2) throw failure;
      });
      await expect(
        store.request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => now,
          operation: operation(),
        }),
      ).rejects.toBe(failure);
      expect((await f.read())?.revision).toBe(0);
      expect(await f.count("cloud_team_scores")).toBe(0);
    });
    it("only persists meaningful ticks and atomically locks/unlocks/settles the shared clock", async () => {
      const f = await fixture(engine);
      await f.initialize();
      expect(
        await f.store.request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW + 100,
        }),
      ).toMatchObject({ revision: 0 });
      expect((await f.read())?.clock.elapsedMs).toBe(0);
      const locked = await f.store.changeSchedule({
        event: f.event,
        artifact: f.artifact,
        patch: { scoringLocked: true },
        now: () => NOW + 1000,
      });
      expect((await f.read())?.clock).toEqual({
        elapsedMs: 1000,
        pausedMs: 0,
        lockedAt: NOW + 1000,
      });
      await expect(
        f.store.request({
          event: locked,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW + 1500,
          operation: operation(),
        }),
      ).rejects.toThrow("scoring_locked");
      const unlocked = await f.store.changeSchedule({
        event: locked,
        artifact: f.artifact,
        patch: { scoringLocked: false },
        now: () => NOW + 2000,
      });
      expect((await f.read())?.clock).toEqual({ elapsedMs: 1000, pausedMs: 1000 });
      const ended = await f.store.changeSchedule({
        event: unlocked,
        artifact: f.artifact,
        patch: { status: "ENDED", endsAt: new Date(NOW + 3000).toISOString(), scoringLocked: true },
        close: true,
        now: () => NOW + 3000,
      });
      expect((await f.read())?.clock.elapsedMs).toBe(2000);
      expect(
        await sqlCommit(f.sql, await f.store.closeFence(f.event.eventId, f.artifact.problemId)),
      ).toBe(true);
      await f.peer.run("INSERT INTO cloud_installation_control VALUES (1, '{}')");
      expect(
        await f.store.request({
          event: ended,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW + 4000,
        }),
      ).toMatchObject({ revision: 3 });
      await expect(
        f.store.request({
          event: ended,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW + 4000,
          operation: operation(),
        }),
      ).rejects.toThrow("event_ended");
    });
    it("rejects replay after team rotation even though the original response exists", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.peer.run("UPDATE cloud_teams SET payload = json_set(payload, '$.authVersion', 2)");
      await expect(f.request()).rejects.toThrow("unauthorized");
      expect(f.apply).toHaveBeenCalledTimes(1);
    });
    it("retries a schedule change when initialization wins the absent-run fence", async () => {
      const f = await fixture(engine);
      let initialized: Awaited<ReturnType<typeof f.initialize>> | undefined;
      f.before(async (writes) => {
        if (
          !writes.some((write) =>
            write.sql.includes("NOT EXISTS (SELECT 1 FROM cloud_coordination_runs"),
          )
        )
          return;
        f.before(undefined);
        initialized = await new SqlDeploymentsCoordination(f.peer).initialize({
          event: f.event,
          teams: f.teams,
          artifact: f.artifact,
          now: NOW,
        });
      });
      const changed = await f.store.changeSchedule({
        event: f.event,
        artifact: f.artifact,
        patch: { scoringLocked: true },
        now: () => NOW + 1000,
      });
      expect(initialized).toBeDefined();
      expect(changed.scoringLocked).toBe(true);
      expect(await f.read()).toMatchObject({
        runId: initialized?.runId,
        revision: 1,
        match: { matchSecret: initialized?.match.matchSecret },
        clock: { elapsedMs: 1000, pausedMs: 0, lockedAt: NOW + 1000 },
      });
      const eventRow = await f.peer.get("SELECT payload FROM cloud_events WHERE event_id = ?", [
        f.event.eventId,
      ]);
      expect(JSON.parse(String(eventRow?.payload))).toEqual(changed);
      expect(await f.count("cloud_coordination_runs")).toBe(1);
      expect(await f.count("cloud_coordination_scores")).toBe(0);
    });
    it.each(["different event", "outside the pinned roster"])(
      "rejects a stored team from %s before exposing a projection",
      async (scope) => {
        const f = await fixture(engine);
        await f.initialize();
        const team = {
          ...f.team,
          teamId: ulid(),
          eventId: scope === "different event" ? ulid() : f.event.eventId,
        };
        await f.peer.run("INSERT INTO cloud_teams (event_id, team_id, payload) VALUES (?, ?, ?)", [
          team.eventId,
          team.teamId,
          JSON.stringify(team),
        ]);
        const projectForTeam = vi.fn(f.artifact.plugin.projectForTeam);
        await expect(
          f.store.request({
            event: f.event,
            team,
            artifact: { ...f.artifact, plugin: { ...f.artifact.plugin, projectForTeam } },
            now: () => NOW,
          }),
        ).rejects.toThrow("unauthorized");
        expect(projectForTeam).not.toHaveBeenCalled();
        expect(f.apply).not.toHaveBeenCalled();
        expect((await f.read())?.revision).toBe(0);
      },
    );
    it.each([
      [
        "binary snapshot",
        "UPDATE cloud_coordination_runs SET snapshot = CAST(snapshot AS BLOB)",
        "coordination_snapshot_invalid",
      ],
      [
        "mismatched revision",
        "UPDATE cloud_coordination_runs SET payload = json_set(payload, '$.revision', 1)",
        "coordination_snapshot_invalid",
      ],
      [
        "head belonging to another event",
        "UPDATE cloud_coordination_runs SET payload = json_set(payload, '$.eventId', '00000000000000000000000000')",
        "coordination_scope_invalid",
      ],
    ])("rejects a %s before reducing or returning stored state", async (_case, mutation, error) => {
      const f = await fixture(engine);
      await f.initialize();
      await f.peer.run(mutation);
      await expect(f.read()).rejects.toThrow(error);
      await expect(f.request()).rejects.toThrow(error);
      expect(f.apply).not.toHaveBeenCalled();
      expect(await f.count("cloud_team_scores")).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
    });
    it("rejects a receipt whose metadata revision differs from its intact response", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const original = await f.request();
      await f.peer.run(
        "UPDATE cloud_coordination_receipts SET payload = json_set(payload, '$.revision', ?)",
        [original.revision + 1],
      );
      await expect(f.request()).rejects.toThrow("coordination_receipt_invalid");
      expect((await f.read())?.revision).toBe(original.revision);
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect(await f.count("cloud_coordination_receipts")).toBe(1);
    });
    it("does not replay a saved response after the authoritative team is deleted", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.peer.run("DELETE FROM cloud_teams WHERE event_id = ? AND team_id = ?", [
        f.event.eventId,
        f.team.teamId,
      ]);
      await expect(f.request()).rejects.toThrow("unauthorized");
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect((await f.read())?.revision).toBe(1);
      expect(await f.count("cloud_coordination_receipts")).toBe(1);
    });
    it("releases admission without publishing when serialization exhausts the request budget", async () => {
      const f = await fixture(engine);
      await f.initialize();
      let monotonicNow = 0;
      vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
      const store = new SqlDeploymentsCoordination(f.sql, (sample) => {
        if (sample.phase === "encode") monotonicNow += 20001;
      });
      await expect(
        store.request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW,
          operation: operation(),
        }),
      ).rejects.toThrow("coordination_conflict");
      expect(await f.read()).toMatchObject({
        revision: 0,
        match: { scores: { [f.team.teamId]: 0 } },
      });
      expect(await f.count("cloud_team_scores")).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
      const row = await f.peer.get("SELECT payload FROM cloud_coordination_runs");
      expect(JSON.parse(String(row?.payload))).not.toHaveProperty("admissionOwner");
      expect(JSON.parse(String(row?.payload))).not.toHaveProperty("admissionExpiresAt");
    });
    it("protects snapshot and receipt integrity, scope and schema before reduction", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.peer.run("UPDATE cloud_coordination_receipts SET response = '{}' ");
      await expect(f.request()).rejects.toThrow("coordination_receipt_invalid");
      await f.peer.run("UPDATE cloud_coordination_runs SET snapshot = '{}' ");
      await expect(f.read()).rejects.toThrow("coordination_snapshot_invalid");
      expect(f.apply).toHaveBeenCalledTimes(1);
    });
    it("rejects oversized snapshots/responses and incompatible plugin schemas without partial writes", async () => {
      const f = await fixture(engine);
      const initial = await f.initialize();
      await expect(
        f.store.request({
          event: f.event,
          team: f.team,
          now: () => NOW,
          artifact: { ...f.artifact, plugin: { ...f.artifact.plugin, stateSchemaVersion: 99 } },
          operation: operation(),
        }),
      ).rejects.toThrow("coordination_artifact_changed");
      const oversized = {
        ...f.artifact,
        plugin: {
          ...f.artifact.plugin,
          applyOp: () => ({
            padding: "x".repeat(COORDINATION_MAX_BYTES),
            scores: initial.match.scores,
          }),
        },
      };
      await expect(
        f.store.request({
          event: f.event,
          team: f.team,
          now: () => NOW,
          artifact: oversized,
          operation: operation(),
        }),
      ).rejects.toThrow("coordination_state_too_large");
      const response = {
        ...f.artifact,
        plugin: { ...f.artifact.plugin, projectForTeam: () => "x".repeat(COORDINATION_MAX_BYTES) },
      };
      await expect(
        f.store.request({
          event: f.event,
          team: f.team,
          now: () => NOW,
          artifact: response,
          operation: operation(),
        }),
      ).rejects.toThrow("coordination_response_too_large");
      expect((await f.read())?.revision).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
    });
    it("revalidates the closed native snapshot in the deployment teardown path, including replay", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const work = new SqlDeploymentWork(f.sql);
      for (const status of ["READY", "TEARDOWN", "ARCHIVED"] as const)
        await expect(work.closeEvent({ ...f.event, status }, AT)).rejects.toThrow(
          "coordination_not_settled",
        );
      const closed = await f.store.changeSchedule({
        event: f.event,
        artifact: f.artifact,
        patch: { scoringLocked: true },
        close: true,
        now: () => NOW + 1000,
      });
      expect(await work.closeEvent(closed, new Date(NOW + 2000).toISOString())).toBe("closing");
      const closing: EventRecord = {
        ...closed,
        status: "TEARDOWN",
        updatedAt: new Date(NOW + 2000).toISOString(),
      };
      expect(await work.closeEvent(closing, new Date(NOW + 3000).toISOString())).toBe("closing");
      await f.peer.run("UPDATE cloud_coordination_runs SET snapshot = '{}'");
      await expect(work.closeEvent(closing, new Date(NOW + 4000).toISOString())).rejects.toThrow(
        "coordination_snapshot_invalid",
      );
    });
    it("fails closed for malformed archival heads and invalidates a read close fence on revision change", async () => {
      const f = await fixture(engine);
      expect(
        await sqlCommit(f.sql, [sqlCoordinationClosedGuard(f.event.eventId, f.artifact.problemId)]),
      ).toBe(true);
      await f.initialize();
      expect(
        await sqlCommit(f.sql, [sqlCoordinationClosedGuard(f.event.eventId, f.artifact.problemId)]),
      ).toBe(false);
      await expect(f.store.closeFence(f.event.eventId, f.artifact.problemId)).rejects.toThrow(
        "coordination_not_settled",
      );
      await f.store.changeSchedule({
        event: f.event,
        artifact: f.artifact,
        patch: { status: "ENDED" },
        close: true,
        now: () => NOW,
      });
      const fence = await f.store.closeFence(f.event.eventId, f.artifact.problemId);
      expect(await sqlCommit(f.sql, fence)).toBe(true);
      await f.peer.run(
        "UPDATE cloud_coordination_runs SET payload = json_set(payload, '$.revision', 2)",
      );
      expect(await sqlCommit(f.sql, fence)).toBe(false);
      await f.peer.run("UPDATE cloud_coordination_runs SET payload = '{}' ");
      expect(
        await sqlCommit(f.sql, [sqlCoordinationClosedGuard(f.event.eventId, f.artifact.problemId)]),
      ).toBe(false);
    });
    it("commits a meaningful tick once and replays a rejected operation without ticking again", async () => {
      const f = await fixture(engine);
      const artifact = {
        ...f.artifact,
        plugin: {
          ...f.artifact.plugin,
          tick: (state: unknown, elapsedMs: number) => {
            const previous = state as State;
            return {
              ...previous,
              scores: Object.fromEntries(
                Object.keys(previous.scores).map((id) => [id, Math.floor(elapsedMs / 1000)]),
              ),
            };
          },
        },
      };
      await f.store.initialize({ event: f.event, teams: f.teams, artifact, now: NOW });
      const request = { event: f.event, team: f.team, artifact, now: () => NOW + 1000 };
      expect(await f.store.request(request)).toMatchObject({
        revision: 1,
        body: { projection: { score: 1 } },
      });
      expect(await f.store.request(request)).toMatchObject({ revision: 1 });
      const rejected = {
        ...request,
        now: () => NOW + 2000,
        operation: operation("rejected-operation", { kind: "reject" }),
      };
      expect(await f.store.request(rejected)).toEqual({
        status: 422,
        body: { error: "rejected" },
        revision: 2,
      });
      expect(await f.store.request({ ...rejected, now: () => NOW + 3000 })).toEqual({
        status: 422,
        body: { error: "rejected" },
        revision: 2,
      });
      expect((await f.read())?.match.scores[f.team.teamId]).toBe(2);
      expect(await f.count("cloud_coordination_scores")).toBe(2);
      expect(await f.count("cloud_coordination_receipts")).toBe(1);
    });
    it("adds native deltas to another scorer's latest score without overwriting its completed count", async () => {
      const f = await fixture(engine);
      await f.initialize();
      f.before(async (writes) => {
        if (!publication(writes)) return;
        f.before(undefined);
        await f.peer.run("INSERT INTO cloud_team_scores VALUES (?, ?, ?)", [
          f.event.eventId,
          f.team.teamId,
          JSON.stringify({
            eventId: f.event.eventId,
            teamId: f.team.teamId,
            score: 20,
            completedProblems: 3,
          }),
        ]);
      });
      await f.request();
      expect(
        JSON.parse(
          String(
            (
              await f.peer.get("SELECT payload FROM cloud_team_scores WHERE team_id = ?", [
                f.team.teamId,
              ])
            )?.payload,
          ),
        ),
      ).toMatchObject({ score: 21, completedProblems: 3 });
    });
    it("rolls back publication when an installation drain starts after admission", async () => {
      const f = await fixture(engine);
      await f.initialize();
      let fenced = false;
      const stop = new Error("stop-after-fenced-publication");
      f.before(async (writes) => {
        if (fenced) throw stop;
        if (!publication(writes)) return;
        await f.peer.run("INSERT INTO cloud_installation_control VALUES (1, '{}')");
        fenced = true;
      });
      await expect(f.request()).rejects.toBe(stop);
      expect((await f.read())?.revision).toBe(0);
      expect(await f.count("cloud_team_scores")).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
    });
    it("propagates transport failure and never releases a newer owner's admission", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const nextOwner = "00000000-0000-4000-8000-000000000001";
      const unavailable = Object.assign(new Error("transport unavailable"), {
        code: "SERVER_ERROR",
      });
      f.before(async (writes) => {
        if (!publication(writes)) return;
        await f.peer.run(
          "UPDATE cloud_coordination_runs SET payload = json_set(payload, '$.admissionOwner', ?)",
          [nextOwner],
        );
        throw unavailable;
      });
      await expect(f.request()).rejects.toBe(unavailable);
      const row = await f.peer.get("SELECT payload FROM cloud_coordination_runs");
      expect(JSON.parse(String(row?.payload))).toMatchObject({
        admissionOwner: nextOwner,
        revision: 0,
      });
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
    });
    it("checks the event end again after serialization and publishes no expired move", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const event = { ...f.event, endsAt: new Date(NOW + 1000).toISOString() };
      await f.peer.run("UPDATE cloud_events SET payload = ?", [JSON.stringify(event)]);
      let now = NOW;
      const store = new SqlDeploymentsCoordination(f.sql, (sample) => {
        if (sample.phase === "encode") now += 1000;
      });
      await expect(
        store.request({
          event,
          team: f.team,
          artifact: f.artifact,
          now: () => now,
          operation: operation(),
        }),
      ).rejects.toThrow("event_ended");
      expect((await f.read())?.revision).toBe(0);
      expect(await f.count("cloud_team_scores")).toBe(0);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
    });
    it("handles a 25-team bounded burst above 400 KiB with one score/receipt publication per operation", async () => {
      const f = await fixture(engine, 25, 795000);
      const initial = await f.initialize();
      expect(jsonBytes(initial.match).byteLength).toBeGreaterThan(400 * 1024);
      const inputs = f.teams.map((team, index) => ({
        event: f.event,
        team,
        artifact: f.artifact,
        now: () => NOW,
        operation: operation(`burst-operation-${index}`),
      }));
      const responses = await Promise.all(inputs.map((input) => f.store.request(input)));
      expect(new Set(responses.map((response) => response.revision)).size).toBe(25);
      expect((await f.read())?.revision).toBe(25);
      expect(Object.values((await f.read())?.match.scores ?? {})).toEqual(Array(25).fill(25));
      expect(await f.count("cloud_coordination_receipts")).toBe(25);
      expect(await f.count("cloud_coordination_scores")).toBe(25);
      expect(await f.count("cloud_team_scores")).toBe(25);
      const replay = await Promise.all(
        inputs.map((input) => new SqlDeploymentsCoordination(f.peer).request(input)),
      );
      expect(replay).toEqual(responses);
      expect(f.apply).toHaveBeenCalledTimes(25);
    }, 30000);
  });

it("runs the actual Crypto Battle plugin through the same SQL reducer and a 25-team admission burst", async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../../problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const source = bundle.outputFiles?.[0]?.text;
  if (!source) throw new Error("Missing canonical plugin bundle");
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as { default: HostPlugin };
  const f = await fixture("libsql", 25);
  const artifact = { ...f.artifact, plugin: module.default };
  const run = await f.store.initialize({ event: f.event, teams: f.teams, artifact, now: NOW });
  const inputs = f.teams.map((team, index) => ({
    event: f.event,
    team,
    artifact,
    now: () => NOW,
    operation: operation(`canonical-ready-${index}`, { kind: "ready" }),
  }));
  const responses = await Promise.all(inputs.map((input) => f.store.request(input)));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const current = await f.read();
  if (!current) throw new Error("Missing canonical run");
  expect(current.revision).toBe(25);
  expect(current?.match.matchSecret).toBe(run.match.matchSecret);
  expect(current?.match.stateSchemaVersion).toBe(module.default.stateSchemaVersion);
  expect((current.match.state as { readyTeamIds: string[] }).readyTeamIds).toHaveLength(25);
  expect(JSON.stringify(responses)).not.toContain(run.match.matchSecret);
  expect(await Promise.all(inputs.map((input) => f.store.request(input)))).toEqual(responses);
}, 30000);
