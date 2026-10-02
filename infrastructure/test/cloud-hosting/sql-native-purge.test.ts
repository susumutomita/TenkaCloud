import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { HostPlugin } from "../../../scripts/local-host/coordination-core.js";
import { purgeRunReference } from "../../lib/problem-deploy/control-data/coordination-purge.js";
import { hash } from "../../lib/problem-deploy/control-data/coordination-state.js";
import {
  type NativeCoordinationArtifact,
  SQL_COORDINATION_MAX_BYTES,
} from "../../lib/problem-deploy/control-data/domain/coordination.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import type { InstallationScope } from "../../lib/problem-deploy/control-data/installation-control.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlCloudRepository } from "../../lib/problem-deploy/control-data/sql-cloud-repository.js";
import {
  headSchema,
  sqlHeadCheck,
} from "../../lib/problem-deploy/control-data/sql-coordination-snapshot.js";
import { SqlDeploymentsCoordination } from "../../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import type {
  SqlExecutor,
  SqlParam,
  SqlStatement,
} from "../../lib/problem-deploy/control-data/sql-port.js";
import { sqlCommit } from "../../lib/problem-deploy/control-data/sql-transaction.js";
import { sqliteFixture } from "./sql-fixture.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const INSTALLATION: InstallationScope = {
  account: "123456789012",
  region: "us-east-1",
  environment: "development",
  applicationStackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud/app-id",
  backendStackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy/backend-id",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
type Engine = "sqlite" | "libsql";
interface State {
  readonly scores: Record<string, number>;
  readonly padding: string;
}
const purging = (writes: readonly SqlStatement[]) =>
  writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ''"));
const pruning = (writes: readonly SqlStatement[]) =>
  !purging(writes) &&
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
async function fixture(engine: Engine, padding = 0) {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-native-purge-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "native.db");
  const base = await connection(engine, path);
  const peer = await connection(engine, path);
  let before: ((writes: readonly SqlStatement[]) => void | Promise<void>) | undefined;
  let after: ((writes: readonly SqlStatement[]) => void | Promise<void>) | undefined;
  let beforeRead:
    | ((statement: string, params: readonly SqlParam[]) => void | Promise<void>)
    | undefined;
  const sql: SqlExecutor = {
    run: base.run.bind(base),
    get: async (statement, params = []) => {
      await beforeRead?.(statement, params);
      return base.get(statement, params);
    },
    all: base.all.bind(base),
    batch: async (writes) => {
      await before?.(writes);
      const result = await base.batch(writes);
      await after?.(writes);
      return result;
    },
  };
  const event: EventRecord = {
    eventId: ulid(NOW),
    name: "SQL native purge",
    status: "READY",
    teamCount: 1,
    problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
    createdAt: AT,
    updatedAt: AT,
    startsAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "team-one",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  const plugin: HostPlugin = {
    initialState: (context) => ({
      scores: Object.fromEntries(context.teamIds.map((id) => [id, 7])),
      padding: "x".repeat(padding),
    }),
    validateOp: () => ({ ok: true }),
    applyOp: (state) => ({
      ...(state as State),
      scores: Object.fromEntries(
        Object.entries((state as State).scores).map(([id, score]) => [id, score + 3]),
      ),
    }),
    projectForTeam: (state, id) => ({ score: (state as State).scores[id] }),
    teamScores: (state) => (state as State).scores,
  };
  const artifactDigest = hash("sql-purge-fixture");
  const artifact: NativeCoordinationArtifact = {
    problemId: "ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${hash("catalog")}.json`,
    stateBudget: { baseBytes: 1536 + padding, bytesPerTeam: 256 },
    plugin,
  };
  await base.run("INSERT INTO cloud_events VALUES (?, ?)", [event.eventId, JSON.stringify(event)]);
  await base.run("INSERT INTO cloud_teams VALUES (?, ?, ?)", [
    event.eventId,
    team.teamId,
    JSON.stringify(team),
  ]);
  await base.run("INSERT INTO cloud_team_scores VALUES (?, ?, ?)", [
    event.eventId,
    team.teamId,
    JSON.stringify({
      eventId: event.eventId,
      teamId: team.teamId,
      score: 100,
      completedProblems: 2,
    }),
  ]);
  const store = new SqlDeploymentsCoordination(sql);
  const peerStore = new SqlDeploymentsCoordination(peer);
  const scope = [event.eventId, artifact.problemId];
  const head = async () => {
    const row = await base.get(
      "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
      scope,
    );
    if (!row) throw new Error("Missing native head");
    return { row, parsed: headSchema.parse(JSON.parse(String(row.payload))) };
  };
  return {
    sql,
    base,
    peer,
    store,
    peerStore,
    event,
    team,
    artifact,
    scope,
    head,
    initialize: () => store.initialize({ event, teams: [team], artifact, now: NOW }),
    read: () => store.read(event.eventId, artifact.problemId),
    summary: () => store.summary(event.eventId, artifact.problemId),
    purge: () => store.purge(event.eventId, artifact.problemId),
    reset: (expectedRunId: string) =>
      store.reset({ event, artifact, expectedRunId, now: () => NOW }),
    close: () =>
      store.changeSchedule({
        event,
        artifact,
        patch: { scoringLocked: true },
        close: true,
        now: () => NOW + 1000,
      }),
    request: (runId?: string) =>
      store.request({
        event,
        team,
        artifact,
        now: () => NOW + 500,
        operation: { runId, key: "operation-one", hash: hash("score"), op: { kind: "score" } },
      }),
    rows: (table: string) => base.all(`SELECT * FROM ${table} WHERE event_id = ?`, [event.eventId]),
    before: (hook: typeof before) => {
      before = hook;
    },
    after: (hook: typeof after) => {
      after = hook;
    },
    beforeRead: (hook: typeof beforeRead) => {
      beforeRead = hook;
    },
  };
}

for (const engine of ["sqlite", "libsql"] as const)
  describe(`${engine}: explicit private native payload purge`, () => {
    it("verifies ordinary summaries and leaves an absent run absent", async () => {
      const f = await fixture(engine);
      expect(await f.summary()).toBeUndefined();
      await f.purge();
      expect(await f.summary()).toBeUndefined();
      const run = await f.initialize();
      expect(await f.summary()).toEqual({
        eventId: f.event.eventId,
        problemId: f.artifact.problemId,
        runId: run.runId,
        revision: 0,
        closed: false,
      });
      await expect(f.purge()).rejects.toThrow("coordination_not_settled");
      await f.peer.run("UPDATE cloud_coordination_runs SET snapshot = '{}' WHERE event_id = ?", [
        f.event.eventId,
      ]);
      await expect(f.summary()).rejects.toThrow("coordination_snapshot_invalid");
      await expect(f.purge()).rejects.toThrow("coordination_snapshot_invalid");
    });

    it("does not report a successful absent-head purge while orphan private receipts remain", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.peer.run("DELETE FROM cloud_coordination_runs WHERE event_id = ?", [f.event.eventId]);
      const receipts = await f.rows("cloud_coordination_receipts");
      await expect(f.purge()).rejects.toThrow("coordination_history_invalid");
      expect(await f.rows("cloud_coordination_receipts")).toEqual(receipts);
    });

    it("fences a purge whose installation intake closes after validation but before its commit", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.close();
      const previous = (await f.head()).row;
      const receipts = await f.rows("cloud_coordination_receipts");
      f.before(async (writes) => {
        if (!purging(writes)) return;
        f.before(undefined);
        await new SqlCloudRepository(f.peer).stopAcceptingInstallation(INSTALLATION, AT);
      });
      await expect(f.purge()).rejects.toThrow("coordination_purge_intake_closed");
      expect((await f.head()).row).toEqual(previous);
      expect(await f.rows("cloud_coordination_receipts")).toEqual(receipts);
    });

    it("cannot start a purge between platform drain validation and the DRAINED commit", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.close();
      const previous = (await f.head()).row;
      await f.base.run(
        "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'ARCHIVED', '$.teardownExpected', 0, '$.teardownCompleted', 0) WHERE event_id = ?",
        [f.event.eventId],
      );
      const repository = new SqlCloudRepository(f.sql);
      await repository.stopAcceptingInstallation(INSTALLATION, AT);
      let intercepted = false;
      f.before(async (writes) => {
        if (
          !writes.some((write) =>
            write.sql.startsWith("UPDATE cloud_installation_control SET payload = ?"),
          )
        )
          return;
        f.before(undefined);
        intercepted = true;
        await expect(f.peerStore.purge(f.event.eventId, f.artifact.problemId)).rejects.toThrow(
          "coordination_purge_intake_closed",
        );
      });
      await repository.confirmInstallationDrained(INSTALLATION, AT);
      expect(intercepted).toBe(true);
      expect(await repository.installationControl()).toMatchObject({ status: "DRAINED" });
      expect((await f.head()).row).toEqual(previous);
      await expect(f.purge()).rejects.toThrow("coordination_purge_intake_closed");
    });

    it("allows already-complete retries throughout DRAINING and DRAINED", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.close();
      await f.purge();
      const completed = (await f.head()).row;
      const repository = new SqlCloudRepository(f.base);
      await repository.stopAcceptingInstallation(INSTALLATION, AT);
      await f.purge();
      expect((await f.head()).row).toEqual(completed);
      await f.base.run(
        "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'ARCHIVED', '$.teardownExpected', 0, '$.teardownCompleted', 0) WHERE event_id = ?",
        [f.event.eventId],
      );
      await repository.confirmInstallationDrained(INSTALLATION, AT);
      await f.purge();
      expect((await f.head()).row).toEqual(completed);
      expect(await repository.installationControl()).toMatchObject({ status: "DRAINED" });
    });

    it("atomically purges current, two retained and one retired run while preserving every score and external record", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      const runs = [first.runId];
      for (let index = 0; index < 3; index++) {
        await f.request(runs.at(-1));
        if (index === 2)
          f.before((writes) => {
            if (pruning(writes)) throw new Error("prune-interrupted");
          });
        if (index === 2)
          await expect(f.reset(runs.at(-1) as string)).rejects.toThrow(
            "coordination_history_prune_failed",
          );
        else await f.reset(runs.at(-1) as string);
        runs.push((await f.head()).parsed.runId);
      }
      f.before(undefined);
      await f.request(runs.at(-1));
      expect((await f.head()).parsed.retiredRuns).toEqual([first.runId]);
      await f.close();
      const prior = await f.head();
      const retained = await f.rows("cloud_coordination_history");
      const secrets = [
        first.match.matchSecret,
        ...retained.map((row) => JSON.parse(String(row.snapshot)).matchSecret),
      ];
      const scores = await f.rows("cloud_coordination_scores");
      const totals = await f.rows("cloud_team_scores");
      await f.base.run("INSERT INTO cloud_deployments VALUES (?, ?, ?, ?, ?)", [
        ulid(),
        f.event.eventId,
        f.team.teamId,
        "external-problem",
        '{"untouched":true}',
      ]);
      const external = await f.rows("cloud_deployments");
      const teams = await f.rows("cloud_teams");
      const events = await f.rows("cloud_events");
      await f.purge();
      const after = await f.head();
      expect(after.row.snapshot).toBe("");
      expect(after.parsed).toMatchObject({
        runId: prior.parsed.runId,
        revision: prior.parsed.revision,
        snapshotDigest: prior.parsed.snapshotDigest,
        closed: true,
        purge: {
          state: "complete",
          runs: runs
            .slice()
            .reverse()
            .map((runId) => ({ runId })),
        },
      });
      expect(await f.rows("cloud_coordination_history")).toEqual([]);
      expect(await f.rows("cloud_coordination_receipts")).toEqual([]);
      for (const secret of secrets) expect(String(after.row.payload)).not.toContain(secret);
      expect(await f.rows("cloud_coordination_scores")).toEqual(scores);
      expect(await f.rows("cloud_team_scores")).toEqual(totals);
      expect(await f.rows("cloud_deployments")).toEqual(external);
      expect(await f.rows("cloud_events")).toEqual(events);
      expect(await f.rows("cloud_teams")).toEqual(teams);
      expect(await f.summary()).toEqual({
        eventId: f.event.eventId,
        problemId: f.artifact.problemId,
        runId: prior.parsed.runId,
        revision: prior.parsed.revision,
        closed: true,
        purgeState: "complete",
      });
      expect(
        await f.store.listScoreEvents(f.event.eventId, f.artifact.problemId, f.team.teamId),
      ).toHaveLength(scores.length);
      const completed = after.row;
      await f.purge();
      expect((await f.head()).row).toEqual(completed);
      for (const runId of runs)
        await expect(f.store.readRun(f.event.eventId, f.artifact.problemId, runId)).rejects.toThrow(
          "coordination_run_closed",
        );
      await expect(f.read()).rejects.toThrow("coordination_run_closed");
      await expect(f.initialize()).rejects.toThrow("coordination_run_closed");
      await expect(f.reset(prior.parsed.runId)).rejects.toThrow("coordination_run_closed");
      await expect(f.request(prior.parsed.runId)).rejects.toThrow("coordination_run_closed");
    });

    it("purges four near-4-MiB snapshots atomically while preserving audits and the permanent manifest", async () => {
      const f = await fixture(engine, SQL_COORDINATION_MAX_BYTES - 2048);
      const first = await f.initialize();
      const runIds = [first.runId];
      for (let index = 0; index < 3; index++) {
        const runId = runIds.at(-1) as string;
        await f.request(runId);
        if (index === 2) {
          f.before((writes) => {
            if (pruning(writes)) throw new Error("max-state-prune-interrupted");
          });
          await expect(f.reset(runId)).rejects.toThrow("coordination_history_prune_failed");
        } else await f.reset(runId);
        runIds.push((await f.head()).parsed.runId);
      }
      f.before(undefined);
      await f.request(runIds.at(-1));
      await f.close();
      const previous = (await f.head()).parsed;
      expect(previous.retiredRuns).toEqual([first.runId]);
      const sizes = await f.base.all(
        `SELECT length(CAST(snapshot AS BLOB)) AS size FROM cloud_coordination_runs WHERE event_id = ?
         UNION ALL SELECT length(CAST(snapshot AS BLOB)) AS size FROM cloud_coordination_history WHERE event_id = ?`,
        [f.event.eventId, f.event.eventId],
      );
      expect(sizes).toHaveLength(4);
      for (const { size } of sizes) {
        expect(Number(size)).toBeGreaterThan(SQL_COORDINATION_MAX_BYTES - 4096);
        expect(Number(size)).toBeLessThanOrEqual(SQL_COORDINATION_MAX_BYTES);
      }
      const audits = await f.rows("cloud_coordination_scores");
      const totals = await f.rows("cloud_team_scores");
      expect(audits).toHaveLength(8);
      let guardedSnapshots = 0;
      f.before((writes) => {
        if (!purging(writes)) return;
        guardedSnapshots = writes
          .flatMap((write) => write.params ?? [])
          .filter(
            (value) =>
              typeof value === "string" &&
              Buffer.byteLength(value) > SQL_COORDINATION_MAX_BYTES - 4096,
          ).length;
      });
      await f.purge();
      expect(guardedSnapshots).toBe(4);
      expect(await f.rows("cloud_coordination_history")).toEqual([]);
      expect(await f.rows("cloud_coordination_receipts")).toEqual([]);
      expect(await f.rows("cloud_coordination_scores")).toEqual(audits);
      expect(await f.rows("cloud_team_scores")).toEqual(totals);
      const completed = await f.head();
      expect(completed.row.snapshot).toBe("");
      expect(completed.parsed).toMatchObject({
        closed: true,
        runId: previous.runId,
        revision: previous.revision,
        snapshotDigest: previous.snapshotDigest,
        purge: {
          state: "complete",
          runs: runIds
            .slice()
            .reverse()
            .map((runId) => ({ runId })),
        },
      });
      expect(await f.summary()).toMatchObject({
        runId: previous.runId,
        closed: true,
        purgeState: "complete",
      });
      await f.purge();
      expect((await f.head()).row).toEqual(completed.row);
    }, 30000);

    for (const damage of ["missing", "corrupt", "unlisted"] as const)
      it(`fails closed before erasure for ${damage} retained history`, async () => {
        const f = await fixture(engine);
        const first = await f.initialize();
        await f.request(first.runId);
        await f.reset(first.runId);
        await f.close();
        if (damage === "missing")
          await f.peer.run("DELETE FROM cloud_coordination_history WHERE event_id = ?", [
            f.event.eventId,
          ]);
        else if (damage === "corrupt")
          await f.peer.run(
            "UPDATE cloud_coordination_history SET snapshot = '{}' WHERE event_id = ?",
            [f.event.eventId],
          );
        else
          await f.peer.run(
            "INSERT INTO cloud_coordination_history SELECT event_id, problem_id, ?, payload, snapshot FROM cloud_coordination_history WHERE event_id = ?",
            [ulid(), f.event.eventId],
          );
        const before = await f.head();
        const receipts = await f.rows("cloud_coordination_receipts");
        await expect(f.purge()).rejects.toThrow(
          damage === "corrupt" ? "coordination_snapshot_invalid" : "coordination_history_invalid",
        );
        expect((await f.head()).row).toEqual(before.row);
        expect(await f.rows("cloud_coordination_receipts")).toEqual(receipts);
      });

    it("accepts a verified peer purge that deletes history between inventory and its snapshot read", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request(first.runId);
      await f.reset(first.runId);
      await f.close();
      let completed: unknown;
      f.beforeRead(async (statement) => {
        if (!statement.includes("SELECT payload, snapshot FROM cloud_coordination_history")) return;
        f.beforeRead(undefined);
        await f.peerStore.purge(f.event.eventId, f.artifact.problemId);
        completed = (await f.head()).row;
      });
      await f.purge();
      expect((await f.head()).row).toEqual(completed);
      expect(await f.summary()).toMatchObject({ purgeState: "complete" });
      expect(await f.rows("cloud_coordination_history")).toEqual([]);
      expect(await f.rows("cloud_coordination_receipts")).toEqual([]);
    });

    it("retries verified retirement between history inventory and the retired snapshot read", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      let runId = first.runId;
      for (let index = 0; index < 3; index++) {
        if (index === 2) {
          f.before((writes) => {
            if (pruning(writes)) throw new Error("retirement-interrupted");
          });
          await expect(f.reset(runId)).rejects.toThrow("coordination_history_prune_failed");
        } else await f.reset(runId);
        runId = (await f.head()).parsed.runId;
      }
      f.before(undefined);
      await f.close();
      const audits = await f.rows("cloud_coordination_scores");
      let retired = false;
      f.beforeRead(async (statement, params) => {
        if (
          !statement.includes("SELECT payload, snapshot FROM cloud_coordination_history") ||
          params[2] !== first.runId
        )
          return;
        f.beforeRead(undefined);
        await f.peerStore.pruneHistory(f.event.eventId, f.artifact.problemId);
        retired = true;
      });
      await f.purge();
      expect(retired).toBe(true);
      const completed = (await f.head()).parsed;
      expect(completed.retiredRuns).toBeUndefined();
      expect(completed.purge?.runs).toHaveLength(3);
      expect(completed.purge?.runs.some((run) => run.runId === first.runId)).toBe(false);
      expect(await f.rows("cloud_coordination_history")).toEqual([]);
      expect(await f.rows("cloud_coordination_scores")).toEqual(audits);
    });

    it("fences a history corruption after verification and rolls back every deletion", async () => {
      const f = await fixture(engine);
      const first = await f.initialize();
      await f.request(first.runId);
      await f.reset(first.runId);
      await f.close();
      const before = await f.head();
      const receipts = await f.rows("cloud_coordination_receipts");
      f.before(async (writes) => {
        if (!purging(writes)) return;
        f.before(undefined);
        await f.peer.run(
          "UPDATE cloud_coordination_history SET snapshot = '{}' WHERE event_id = ?",
          [f.event.eventId],
        );
      });
      await expect(f.purge()).rejects.toThrow("coordination_snapshot_invalid");
      expect((await f.head()).row).toEqual(before.row);
      expect(await f.rows("cloud_coordination_history")).toHaveLength(1);
      expect(await f.rows("cloud_coordination_receipts")).toEqual(receipts);
    });

    it("fences a current snapshot corruption after verification", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.close();
      const receipts = await f.rows("cloud_coordination_receipts");
      f.before(async (writes) => {
        if (!purging(writes)) return;
        f.before(undefined);
        await f.peer.run("UPDATE cloud_coordination_runs SET snapshot = '{}' WHERE event_id = ?", [
          f.event.eventId,
        ]);
      });
      await expect(f.purge()).rejects.toThrow("coordination_snapshot_invalid");
      expect((await f.head()).parsed.purge).toBeUndefined();
      expect(await f.rows("cloud_coordination_receipts")).toEqual(receipts);
    });

    it("keeps a completed manifest through stale closed publication and invalidates pre-purge fences", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const closedEvent = await f.close();
      const fence = await f.store.closeFence(f.event.eventId, f.artifact.problemId);
      const run = await f.read();
      if (!run) throw new Error("Missing closed run");
      const stored = { ...run, ...(await f.head()).parsed };
      f.before(async (writes) => {
        if (!writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ?"))) return;
        f.before(undefined);
        await f.peerStore.purge(f.event.eventId, f.artifact.problemId);
      });
      await expect(
        f.store.changeSchedule({
          event: closedEvent,
          artifact: f.artifact,
          patch: { scoringLocked: true },
          close: true,
          now: () => NOW + 2000,
        }),
      ).rejects.toThrow("coordination_run_closed");
      expect((await f.head()).row.snapshot).toBe("");
      expect(await sqlCommit(f.base, fence)).toBe(false);
      expect(await sqlCommit(f.base, [sqlHeadCheck(stored)])).toBe(false);
      const completeFence = await f.store.closeFence(f.event.eventId, f.artifact.problemId);
      expect(await sqlCommit(f.base, completeFence)).toBe(true);
      await f.peer.run(
        "UPDATE cloud_coordination_runs SET payload = json_set(payload, '$.purge.state', 'pending') WHERE event_id = ?",
        [f.event.eventId],
      );
      expect(await sqlCommit(f.base, completeFence)).toBe(false);
      expect(await f.summary()).toMatchObject({ purgeState: "pending" });
      await expect(f.store.closeFence(f.event.eventId, f.artifact.problemId)).rejects.toThrow(
        "coordination_purge_pending",
      );
      await expect(f.purge()).rejects.toThrow("coordination_purge_pending");
    });

    for (const action of ["initialize", "reset", "operation"] as const)
      it(`prevents an in-flight ${action} from publishing over a completed purge`, async () => {
        const f = await fixture(engine);
        const initial = action === "initialize" ? undefined : await f.initialize();
        let completed: unknown;
        let totals: unknown;
        f.before(async (writes) => {
          const publication = writes.some((write) =>
            action === "initialize"
              ? write.sql.startsWith("INSERT INTO cloud_coordination_runs")
              : write.sql.includes("SET payload = ?, snapshot = ?"),
          );
          if (!publication) return;
          f.before(undefined);
          if (action === "initialize")
            await f.peerStore.initialize({
              event: f.event,
              teams: [f.team],
              artifact: f.artifact,
              now: NOW,
            });
          await f.peerStore.changeSchedule({
            event: f.event,
            artifact: f.artifact,
            patch: { scoringLocked: true },
            close: true,
            now: () => NOW + 1000,
          });
          await f.peerStore.purge(f.event.eventId, f.artifact.problemId);
          completed = (await f.head()).row;
          totals = await f.rows("cloud_team_scores");
        });
        let attempt: Promise<unknown>;
        if (action === "initialize") attempt = f.initialize();
        else if (action === "reset") attempt = f.reset(initial?.runId as string);
        else attempt = f.request(initial?.runId);
        await expect(attempt).rejects.toThrow(
          action === "reset" ? "run_rotation_conflict" : "event_changed",
        );
        expect((await f.head()).row).toEqual(completed);
        expect(await f.rows("cloud_team_scores")).toEqual(totals);
        expect(await f.rows("cloud_coordination_history")).toEqual([]);
        expect(await f.rows("cloud_coordination_receipts")).toEqual([]);
      });

    it("does not return an already-decoded private projection after purge wins the read authorization fence", async () => {
      const f = await fixture(engine);
      await f.initialize();
      const event = await f.close();
      let intercepted = false;
      const sql: SqlExecutor = {
        run: f.base.run.bind(f.base),
        all: f.base.all.bind(f.base),
        batch: f.base.batch.bind(f.base),
        get: async (statement, params) => {
          if (!intercepted && statement.includes("AS installation")) {
            intercepted = true;
            await f.peerStore.purge(f.event.eventId, f.artifact.problemId);
          }
          return f.base.get(statement, params);
        },
      };
      const store = new SqlDeploymentsCoordination(sql);
      await expect(
        store.request({ event, team: f.team, artifact: f.artifact, now: () => NOW + 2000 }),
      ).rejects.toThrow("coordination_run_closed");
      expect(intercepted).toBe(true);
      expect(await f.summary()).toMatchObject({ purgeState: "complete" });
    });

    it("resumes an uncertain successful commit without needing deleted snapshots", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.close();
      f.after((writes) => {
        if (!purging(writes)) return;
        f.after(undefined);
        throw new Error("response-lost-after-commit");
      });
      await expect(f.purge()).rejects.toThrow("response-lost-after-commit");
      expect(await f.summary()).toMatchObject({ purgeState: "complete" });
      const complete = (await f.head()).row;
      await f.purge();
      expect((await f.head()).row).toEqual(complete);
      expect(await f.rows("cloud_coordination_receipts")).toEqual([]);
    });

    it("does not erase another event or another problem in the same event", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.request();
      await f.close();
      const otherEvent = ulid();
      for (const [eventId, problemId] of [
        [otherEvent, f.artifact.problemId],
        [f.event.eventId, "external-problem"],
      ]) {
        await f.base.run(
          "INSERT INTO cloud_coordination_runs SELECT ?, ?, payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
          [eventId as string, problemId as string, ...f.scope],
        );
        await f.base.run(
          "INSERT INTO cloud_coordination_receipts SELECT ?, ?, run_id, team_id, operation_hash, payload, response FROM cloud_coordination_receipts WHERE event_id = ? AND problem_id = ?",
          [eventId as string, problemId as string, ...f.scope],
        );
      }
      const otherHeads = await f.base.all(
        "SELECT * FROM cloud_coordination_runs WHERE event_id != ? OR problem_id != ?",
        f.scope,
      );
      const otherReceipts = await f.base.all(
        "SELECT * FROM cloud_coordination_receipts WHERE event_id != ? OR problem_id != ?",
        f.scope,
      );
      await f.purge();
      expect(
        await f.base.all(
          "SELECT * FROM cloud_coordination_runs WHERE event_id != ? OR problem_id != ?",
          f.scope,
        ),
      ).toEqual(otherHeads);
      expect(
        await f.base.all(
          "SELECT * FROM cloud_coordination_receipts WHERE event_id != ? OR problem_id != ?",
          f.scope,
        ),
      ).toEqual(otherReceipts);
    });

    it("rejects forged manifests and never mistakes an empty ordinary snapshot for a purge", async () => {
      const f = await fixture(engine);
      await f.initialize();
      await f.close();
      const { row, parsed } = await f.head();
      for (const change of [
        { closed: false },
        { runId: ulid() },
        { snapshotDigest: hash("wrong-snapshot") },
      ]) {
        await f.peer.run(
          "UPDATE cloud_coordination_runs SET payload = ?, snapshot = '' WHERE event_id = ?",
          [
            JSON.stringify({
              ...parsed,
              ...change,
              purge: { state: "complete", runs: [purgeRunReference(parsed)] },
            }),
            f.event.eventId,
          ],
        );
        await expect(f.summary()).rejects.toThrow("coordination_purge_invalid");
        await expect(f.store.closeFence(f.event.eventId, f.artifact.problemId)).rejects.toThrow(
          "coordination_purge_invalid",
        );
        await expect(f.purge()).rejects.toThrow("coordination_purge_invalid");
      }
      await f.peer.run(
        "UPDATE cloud_coordination_runs SET payload = ?, snapshot = '' WHERE event_id = ?",
        [String(row.payload), f.event.eventId],
      );
      await expect(f.summary()).rejects.toThrow("coordination_snapshot_invalid");
      await expect(f.purge()).rejects.toThrow("coordination_snapshot_invalid");
    });
  });
