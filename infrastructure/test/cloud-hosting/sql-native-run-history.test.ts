import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostPlugin } from "../../../scripts/local-host/coordination-core.js";
import { hash } from "../../lib/problem-deploy/control-data/coordination-state.js";
import type { NativeCoordinationArtifact } from "../../lib/problem-deploy/control-data/domain/coordination.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlDeploymentsCoordination } from "../../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import type { SqlExecutor, SqlStatement } from "../../lib/problem-deploy/control-data/sql-port.js";
import { sqliteFixture } from "./sql-fixture.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
type Engine = "sqlite" | "libsql";
const resetPublication = (writes: readonly SqlStatement[]) =>
  writes.some((write) => write.sql.startsWith("INSERT INTO cloud_coordination_history"));
const pruning = (writes: readonly SqlStatement[]) =>
  writes.some((write) => write.sql.startsWith("DELETE FROM cloud_coordination_history"));
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
async function fixture(engine: Engine, count = 2, initial = 7) {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-run-history-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "native.db");
  const base = await connection(engine, path);
  const peer = await connection(engine, path);
  let before: ((writes: readonly SqlStatement[]) => void | Promise<void>) | undefined;
  const sql: SqlExecutor = {
    run: base.run.bind(base),
    get: base.get.bind(base),
    all: base.all.bind(base),
    batch: async (writes) => {
      await before?.(writes);
      return base.batch(writes);
    },
  };
  const event: EventRecord = {
    eventId: ulid(NOW),
    name: "SQL retained runs",
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
  if (!team) throw new Error("Missing team");
  const apply = vi.fn((state: unknown) =>
    Object.fromEntries(
      Object.entries(state as Record<string, number>).map(([id, n]) => [id, n + 3]),
    ),
  );
  const tick = vi.fn((state: unknown) => state);
  const plugin: HostPlugin = {
    initialState: (context) => Object.fromEntries(context.teamIds.map((id) => [id, initial])),
    validateOp: () => ({ ok: true }),
    applyOp: apply,
    projectForTeam: (state, id) => ({ score: (state as Record<string, number>)[id] }),
    teamScores: (state) => state as Record<string, number>,
    tickOnRequest: true,
    tick,
  };
  const artifactDigest = hash("sql-reset-fixture");
  const artifact: NativeCoordinationArtifact = {
    problemId: "ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${hash("catalog")}.json`,
    stateBudget: { baseBytes: 1536, bytesPerTeam: 31744 },
    plugin,
  };
  await base.run("INSERT INTO cloud_events VALUES (?, ?)", [event.eventId, JSON.stringify(event)]);
  for (const value of teams) {
    await base.run("INSERT INTO cloud_teams VALUES (?, ?, ?)", [
      event.eventId,
      value.teamId,
      JSON.stringify(value),
    ]);
    await base.run("INSERT INTO cloud_team_scores VALUES (?, ?, ?)", [
      event.eventId,
      value.teamId,
      JSON.stringify({
        eventId: event.eventId,
        teamId: value.teamId,
        score: 100,
        completedProblems: 2,
      }),
    ]);
  }
  const store = new SqlDeploymentsCoordination(sql);
  const peerStore = new SqlDeploymentsCoordination(peer);
  return {
    base,
    peer,
    store,
    peerStore,
    event,
    teams,
    team,
    artifact,
    apply,
    tick,
    initialize: () => store.initialize({ event, teams, artifact, now: NOW }),
    read: () => store.read(event.eventId, artifact.problemId),
    readRun: (runId: string) => store.readRun(event.eventId, artifact.problemId, runId),
    reset: (expectedRunId: string, target = store) =>
      target.reset({ event, artifact, expectedRunId, now: () => NOW }),
    request: (runId?: string, key = "operation-first") =>
      store.request({
        event,
        team,
        artifact,
        now: () => NOW + 500,
        operation: { runId, key, hash: hash("score"), op: { kind: "score" } },
      }),
    score: async () =>
      JSON.parse(
        String(
          (
            await base.get(
              "SELECT payload FROM cloud_team_scores WHERE event_id = ? AND team_id = ?",
              [event.eventId, team.teamId],
            )
          )?.payload,
        ),
      ) as { score: number; completedProblems: number },
    count: async (table: string) =>
      (await base.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count,
    before: (hook: typeof before) => {
      before = hook;
    },
  };
}

for (const engine of ["sqlite", "libsql"] as const)
  describe(`${engine}: native reset and retained run history`, () => {
    it("atomically projects initial scores and replaces only the native subtotal for 99 teams", async () => {
      const f = await fixture(engine, 99);
      const first = await f.initialize();
      expect((await f.initialize()).runId).toBe(first.runId);
      expect(f.tick).not.toHaveBeenCalled();
      expect(await f.score()).toMatchObject({ score: 107, completedProblems: 2 });
      await f.request(first.runId);
      expect(await f.score()).toMatchObject({ score: 110, completedProblems: 2 });
      const before = await f.read();
      const result = await f.reset(first.runId);
      const next = await f.read();
      expect(result).toMatchObject({ previousRunId: first.runId, runId: next?.runId });
      expect(next?.runId).not.toBe(first.runId);
      expect(next?.match.matchSecret).not.toBe(first.match.matchSecret);
      expect(next).toMatchObject({
        revision: 2,
        artifactDigest: first.artifactDigest,
        roster: first.roster,
        clock: before?.clock,
        history: [first.runId],
        match: {
          stateSchemaVersion: first.match.stateSchemaVersion,
          version: 2,
          scores: first.match.scores,
        },
      });
      expect(await f.score()).toMatchObject({ score: 107, completedProblems: 2 });
      expect(await f.count("cloud_team_scores")).toBe(99);
      const totals = await f.base.all(
        "SELECT json_extract(payload, '$.score') AS score FROM cloud_team_scores",
      );
      expect(totals.every((row) => row.score === 107)).toBe(true);
      expect(await f.count("cloud_coordination_scores")).toBe(3);
      expect(f.tick).toHaveBeenCalledTimes(1);
      expect(await f.readRun(first.runId)).toMatchObject({ ...before, closed: true });
      expect(await f.readRun(next?.runId as string)).toMatchObject(next as object);
    });

    it("retains current plus two previous runs and removes retired snapshots, secrets and receipts", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      const runs = [first.runId];
      for (let index = 0; index < 4; index++) {
        const current = runs.at(-1) as string;
        await f.request(current);
        runs.push((await f.reset(current)).runId);
      }
      const current = await f.read();
      expect(current?.history).toEqual([runs[3], runs[2]]);
      expect(current?.retiredRuns ?? []).toEqual([]);
      expect(await f.count("cloud_coordination_history")).toBe(2);
      expect(await f.count("cloud_coordination_receipts")).toBe(2);
      expect(await f.readRun(runs[0] as string)).toBeUndefined();
      expect(await f.readRun(runs[1] as string)).toBeUndefined();
      for (const runId of runs.slice(2)) expect((await f.readRun(runId))?.runId).toBe(runId);
      expect(
        await f.store.readRun(ulid(), f.artifact.problemId, runs[2] as string),
      ).toBeUndefined();
      expect(await f.count("cloud_coordination_scores")).toBe(9);
      const stored = await f.base.all("SELECT snapshot FROM cloud_coordination_history");
      expect(stored.every((row) => !String(row.snapshot).includes(first.match.matchSecret))).toBe(
        true,
      );
    });

    it("rejects stale or missing run fences before replays or operation reduction", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request();
      const next = await f.reset(first.runId);
      await expect(f.request(first.runId)).rejects.toThrow("coordination_run_changed");
      await expect(f.request()).rejects.toThrow("coordination_run_changed");
      expect(f.apply).toHaveBeenCalledTimes(1);
      const response = await f.request(next.runId);
      expect(await f.request(next.runId)).toEqual(response);
      expect(f.apply).toHaveBeenCalledTimes(2);
      await f.peer.run(
        "UPDATE cloud_teams SET payload = json_set(payload, '$.accessRevoked', json('true')) WHERE team_id = ?",
        [f.team.teamId],
      );
      await expect(f.request(next.runId)).rejects.toThrow("unauthorized");
    });

    it("rolls back the archive, state and score replacement if the event fence fails", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request(first.runId);
      const previous = await f.read();
      f.before(async (writes) => {
        if (!resetPublication(writes)) return;
        f.before(undefined);
        await f.peer.run(
          "UPDATE cloud_events SET payload = json_set(payload, '$.updatedAt', ?) WHERE event_id = ?",
          [new Date(NOW + 1).toISOString(), f.event.eventId],
        );
      });
      await expect(f.reset(first.runId)).rejects.toThrow("run_rotation_conflict");
      expect(await f.read()).toEqual(previous);
      expect(await f.score()).toMatchObject({ score: 110, completedProblems: 2 });
      expect(await f.count("cloud_coordination_history")).toBe(0);
      expect(await f.count("cloud_coordination_scores")).toBe(2);
    });

    it("lets one reset win without retrying against the winner's new run", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      let winningRunId: string | undefined;
      f.before(async (writes) => {
        if (!resetPublication(writes)) return;
        f.before(undefined);
        winningRunId = (await f.reset(first.runId, f.peerStore)).runId;
      });
      await expect(f.reset(first.runId)).rejects.toThrow("run_rotation_conflict");
      expect((await f.read())?.runId).toBe(winningRunId);
      expect(await f.count("cloud_coordination_history")).toBe(1);
      await expect(f.reset(first.runId)).rejects.toThrow("run_rotation_conflict");
      expect((await f.read())?.runId).toBe(winningRunId);
    });

    it("fences an admitted operation when reset wins before operation publication", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      let winningRunId: string | undefined;
      f.before(async (writes) => {
        if (!writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ?"))) return;
        f.before(undefined);
        winningRunId = (await f.reset(first.runId, f.peerStore)).runId;
      });
      await expect(f.request(first.runId)).rejects.toThrow("coordination_run_changed");
      expect((await f.read())?.runId).toBe(winningRunId);
      expect(await f.score()).toMatchObject({ score: 107, completedProblems: 2 });
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
      expect(f.apply).toHaveBeenCalledTimes(1);
    });

    it("recovers interrupted pruning durably before rejecting a stale reset retry", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request(first.runId);
      const second = await f.reset(first.runId);
      const third = await f.reset(second.runId);
      f.before((writes) => {
        if (pruning(writes)) throw new Error("connection interrupted");
      });
      await expect(f.reset(third.runId)).rejects.toThrow("coordination_history_prune_failed");
      const committed = await f.read();
      expect(committed?.runId).not.toBe(third.runId);
      expect(committed?.retiredRuns).toEqual([first.runId]);
      expect(await f.count("cloud_coordination_history")).toBe(3);
      expect(await f.count("cloud_coordination_receipts")).toBe(1);
      expect(await f.readRun(first.runId)).toBeUndefined();
      f.before(undefined);
      await expect(f.reset(third.runId)).rejects.toThrow("run_rotation_conflict");
      expect((await f.read())?.runId).toBe(committed?.runId);
      expect((await f.read())?.retiredRuns ?? []).toEqual([]);
      expect(await f.count("cloud_coordination_history")).toBe(2);
      expect(await f.count("cloud_coordination_receipts")).toBe(0);
      await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    });

    it("fails closed on corrupted archived snapshots", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.reset(first.runId);
      await f.peer.run("UPDATE cloud_coordination_history SET snapshot = '{}' WHERE run_id = ?", [
        first.runId,
      ]);
      await expect(f.readRun(first.runId)).rejects.toThrow("coordination_snapshot_invalid");
    });

    it("fails closed when retained history is missing", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.reset(first.runId);
      await f.peer.run("DELETE FROM cloud_coordination_history WHERE run_id = ?", [first.runId]);
      await expect(f.readRun(first.runId)).rejects.toThrow("coordination_history_invalid");
      expect(await f.readRun(ulid())).toBeUndefined();
    });

    it("reports an uninitialized scope without creating native state", async () => {
      const f = await fixture(engine);
      await expect(f.reset(ulid())).rejects.toMatchObject({
        status: 404,
        code: "coordination_not_initialized",
      });
      expect(await f.read()).toBeUndefined();
      expect(await f.count("cloud_coordination_history")).toBe(0);
    });

    it("does not restore a retired cleanup marker from an operation read before pruning", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      const second = await f.reset(first.runId);
      const third = await f.reset(second.runId);
      f.before((writes) => {
        if (pruning(writes)) throw new Error("interrupted cleanup");
      });
      await expect(f.reset(third.runId)).rejects.toThrow("coordination_history_prune_failed");
      const current = await f.read();
      f.before(async (writes) => {
        if (!writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ?"))) return;
        f.before(undefined);
        await f.peerStore.pruneHistory(f.event.eventId, f.artifact.problemId);
      });
      await f.request(current?.runId);
      expect((await f.read())?.retiredRuns ?? []).toEqual([]);
      expect(await f.count("cloud_coordination_history")).toBe(2);
      expect(await f.readRun(first.runId)).toBeUndefined();
      expect(f.apply).toHaveBeenCalledTimes(2);
      expect(await f.score()).toMatchObject({ score: 110, completedProblems: 2 });
    });

    it("checks event end again after the plugin constructs the replacement match", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      let now = NOW;
      const end = NOW + 1;
      const event = { ...f.event, endsAt: new Date(end).toISOString() };
      await f.peer.run("UPDATE cloud_events SET payload = ? WHERE event_id = ?", [
        JSON.stringify(event),
        f.event.eventId,
      ]);
      const artifact = {
        ...f.artifact,
        plugin: {
          ...f.artifact.plugin,
          initialState: (context: Parameters<HostPlugin["initialState"]>[0]) => {
            now = end;
            return f.artifact.plugin.initialState(context);
          },
        },
      };
      await expect(
        f.store.reset({
          event,
          artifact,
          expectedRunId: first.runId,
          now: () => now,
        }),
      ).rejects.toThrow("event_ended");
      expect((await f.read())?.runId).toBe(first.runId);
      expect(await f.count("cloud_coordination_history")).toBe(0);
      expect(await f.count("cloud_coordination_scores")).toBe(1);
    });

    it("checks installation intake inside the same reset transaction", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request(first.runId);
      const previous = await f.read();
      f.before(async (writes) => {
        if (!resetPublication(writes)) return;
        f.before(undefined);
        await f.peer.run("INSERT INTO cloud_installation_control VALUES (1, '{}')");
      });
      await expect(f.reset(first.runId)).rejects.toThrow("run_rotation_conflict");
      expect(await f.read()).toEqual(previous);
      expect(await f.score()).toMatchObject({ score: 110, completedProblems: 2 });
      expect(await f.count("cloud_coordination_history")).toBe(0);
    });

    it("rejects reset at the event end without publishing an archive", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await expect(
        f.store.reset({
          event: { ...f.event, endsAt: new Date(NOW + 1).toISOString() },
          artifact: f.artifact,
          expectedRunId: first.runId,
          now: () => NOW + 1,
        }),
      ).rejects.toThrow("event_ended");
      expect(await f.count("cloud_coordination_history")).toBe(0);
      expect((await f.read())?.runId).toBe(first.runId);
    });
  });
