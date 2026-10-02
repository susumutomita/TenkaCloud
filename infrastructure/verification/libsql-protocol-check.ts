/** Opt-in real local HTTP protocol rehearsal. No hosted Turso, AWS, credentials or downloads. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ulid } from "ulid";
import { z } from "zod";
import type { HostPlugin } from "../../scripts/local-host/coordination-core.js";
import { hash } from "../lib/problem-deploy/control-data/coordination-state.js";
import type { NativeCoordinationArtifact } from "../lib/problem-deploy/control-data/domain/coordination.js";
import type { EventRecord } from "../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlCloudRepository } from "../lib/problem-deploy/control-data/sql-cloud-repository.js";
import { SqlDeploymentsCoordination } from "../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import type { SqlExecutor } from "../lib/problem-deploy/control-data/sql-port.js";
import { resetControlData } from "../lib/problem-deploy/control-data/sql-reset.js";
import {
  sqlChangesGuard,
  sqlConflict,
} from "../lib/problem-deploy/control-data/sql-transaction.js";
import { eventually, freePort, installedSqld, localClient, startSqld } from "./official-sqld.js";

assert.equal(
  process.argv.length,
  3,
  "Usage: bun verification/libsql-protocol-check.ts /absolute/path/to/sqld",
);
const binary = installedSqld(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), "tenkacloud-official-libsql-"));
const primaryPort = await freePort();
const grpcPort = await freePort();
const replicaPort = await freePort();
const primaryOptions = ["--grpc-listen-addr", `127.0.0.1:${grpcPort}`];
const primaryPath = join(directory, "primary");
const clients = [localClient(primaryPort), localClient(replicaPort)];
const primaryClient = clients[0];
const replicaClient = clients[1];
assert.ok(primaryClient && replicaClient);
const primarySql = new LibsqlExecutor(primaryClient);
const replicaSql = new LibsqlExecutor(replicaClient);
const repository = new SqlCloudRepository(primarySql);
const peer = new SqlCloudRepository(replicaSql);
let primary: Awaited<ReturnType<typeof startSqld>> | undefined;
let replica: Awaited<ReturnType<typeof startSqld>> | undefined;
const now = Date.now();
const at = new Date(now).toISOString();
const event: EventRecord = {
  eventId: ulid(),
  name: "Synthetic official libSQL rehearsal",
  status: "READY",
  teamCount: 25,
  startsAt: at,
  problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
  createdAt: at,
  updatedAt: at,
  expiresAt: Math.floor(now / 1000) + 86400,
};
const teams: TeamRecord[] = Array.from({ length: 25 }, (_, index) => ({
  eventId: event.eventId,
  teamId: ulid(),
  internalSlug: `synthetic-${index}`,
  teamLoginKey: Buffer.alloc(32, index + 1).toString("base64url"),
  authVersion: 1,
  accessRevoked: false,
  createdAt: at,
  updatedAt: at,
  expiresAt: event.expiresAt,
}));
const team = teams[0];
assert.ok(team);
const receipt = {
  scope: "synthetic-organizer",
  key: "create",
  requestHash: "synthetic-request",
  response: { eventId: event.eventId },
};

function assertSameJson(actual: unknown, expected: unknown) {
  // The HTTP contract omits undefined properties from freshly reduced objects.
  assert.equal(hash(JSON.stringify(actual)), hash(JSON.stringify(expected)));
}

async function duplicateCreation() {
  let diagnostic = "";
  await assert.rejects(
    () =>
      replicaSql.batch([
        {
          sql: "INSERT INTO cloud_events (event_id, payload) VALUES (?, ?)",
          params: [event.eventId, JSON.stringify(event)],
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "PROXY_ERROR");
      assert.ok(sqlConflict(error));
      diagnostic = error.message;
      return true;
    },
  );
  assert.equal(await peer.createEventWithTeams(event, teams, receipt), "conflict");
  assert.equal((await peer.listEvents()).length, 1);
  assert.equal((await peer.listTeamsByEvent(event.eventId)).length, 25);
  return diagnostic;
}

async function readBurst() {
  const times: number[] = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const actor = teams[index % teams.length];
      assert.ok(actor);
      const begun = performance.now();
      assert.equal((await peer.authenticateTeam(actor.teamLoginKey, now))?.teamId, actor.teamId);
      times.push(performance.now() - begun);
    }),
  );
  times.sort((a, b) => a - b);
  const percentile = (index: number) => Math.round(times[index] ?? Number.NaN);
  return {
    durationMs: Math.round(performance.now() - start),
    p50Ms: percentile(49),
    p95Ms: percentile(94),
    p99Ms: percentile(98),
  };
}

async function nativeArtifact(): Promise<NativeCoordinationArtifact> {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts",
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
  assert.ok(source, "Missing canonical Crypto Battle bundle");
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as { default: HostPlugin };
  const digest = hash(source);
  return {
    problemId: "ac26-crypto-battle",
    artifactDigest: digest,
    pluginKey: `plugins/${digest}.mjs`,
    catalogKey: `catalogs/${hash("synthetic-protocol-catalog")}.json`,
    stateBudget: { baseBytes: 1536, bytesPerTeam: 31744 },
    plugin: loaded.default,
  };
}

async function nativeBattle(team: TeamRecord) {
  const artifact = await nativeArtifact();
  const store = new SqlDeploymentsCoordination(replicaSql);
  const initial = await store.initialize({ event, teams, artifact, now });
  const input = (actor: TeamRecord, key: string, op: unknown) => ({
    event,
    team: actor,
    artifact,
    now: () => now,
    operation: { key, hash: hash(JSON.stringify(op)), op },
  });
  const ready = teams.map((actor, index) =>
    input(actor, `canonical-ready-${index}`, { kind: "ready" }),
  );
  const responses = await Promise.all(ready.map((request) => store.request(request)));
  assert.ok(responses.every((response) => response.status === 200));
  assertSameJson(await Promise.all(ready.map((request) => store.request(request))), responses);
  const before = await store.read(event.eventId, artifact.problemId);
  assert.ok(before);
  assert.equal(before.revision, 25);
  assert.ok(!JSON.stringify(responses).includes(initial.match.matchSecret));
  const polls = await Promise.all(
    Array.from({ length: 100 }, (_, index) => {
      const actor = teams[index % teams.length];
      assert.ok(actor);
      return store.request({ event, team: actor, artifact, now: () => now });
    }),
  );
  assert.ok(polls.every((response) => response.status === 200 && response.revision === 25));
  assert.ok(!JSON.stringify(polls).includes(initial.match.matchSecret));
  const state = z
    .object({
      readyTeamIds: z.array(z.string()),
      contracts: z.array(
        z.object({ id: z.string(), teamId: z.string(), allowedMethods: z.array(z.string()) }),
      ),
    })
    .parse(before.match.state);
  assert.equal(state.readyTeamIds.length, 25);
  const contract = state.contracts.find(
    (entry) => entry.teamId === team.teamId && entry.allowedMethods.includes("leak"),
  );
  assert.ok(contract, "Canonical opening share Order must remain playable");
  const leak = input(team, "first-leak", { kind: "leak", contractId: contract.id });
  const counts = () =>
    Promise.all([
      primarySql.get("SELECT COUNT(*) AS count FROM cloud_team_scores"),
      primarySql.get("SELECT COUNT(*) AS count FROM cloud_coordination_scores"),
      primarySql.get("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"),
    ]);
  const beforeCounts = await counts();
  let lateRollback = false;
  const injected: SqlExecutor = {
    run: replicaSql.run.bind(replicaSql),
    all: replicaSql.all.bind(replicaSql),
    get: replicaSql.get.bind(replicaSql),
    batch: async (writes) => {
      if (
        lateRollback ||
        !writes.some((write) => write.sql.includes("SET payload = ?, snapshot = ?"))
      )
        return replicaSql.batch(writes);
      // A deterministic lost CAS at the END of a real publication must undo its
      // snapshot, scoreboard, score ledger and immutable receipt together.
      try {
        await replicaSql.batch([
          ...writes,
          {
            sql: "UPDATE cloud_coordination_runs SET payload = payload WHERE event_id = ? AND json_extract(payload, '$.revision') = -1",
            params: [event.eventId],
          },
          sqlChangesGuard(),
        ]);
        assert.fail("A failed late CAS unexpectedly committed");
      } catch (error) {
        assert.ok(sqlConflict(error), "The real server must expose the named CHECK violation");
        const rolledBack = await store.read(event.eventId, artifact.problemId);
        assert.equal(rolledBack?.revision, before.revision);
        assert.deepEqual(rolledBack?.match, before.match);
        assert.deepEqual(await counts(), beforeCounts);
        lateRollback = true;
        throw error;
      }
    },
  };
  const result = await new SqlDeploymentsCoordination(injected).request(leak);
  assert.ok(lateRollback);
  assert.equal(result.status, 200);
  assertSameJson(await store.request(leak), result);
  const after = await store.read(event.eventId, artifact.problemId);
  assert.ok(after);
  assert.equal(after.revision, 26);
  const award = after.match.scores[team.teamId];
  assert.ok(award && award > 0);
  assert.equal(
    (await repository.listTeamScores(event.eventId)).find((row) => row.teamId === team.teamId)
      ?.score,
    award,
  );
  assert.equal(
    (await store.listScoreEvents(event.eventId, artifact.problemId, team.teamId)).length,
    1,
  );
  assert.equal(
    (await primarySql.get("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"))?.count,
    26,
  );
  return { artifact, after, leak, result, award };
}

try {
  primary = await startSqld(binary.path, primaryPath, primaryPort, primaryOptions);
  await initializeControlDataSchema(primaryClient);
  assert.equal(await repository.createEventWithTeams(event, teams, receipt), "created");
  replica = await startSqld(binary.path, join(directory, "replica"), replicaPort, [
    "--primary-grpc-url",
    `http://127.0.0.1:${grpcPort}`,
    "--http-primary-url",
    `http://127.0.0.1:${primaryPort}`,
  ]);
  await eventually(async () => {
    try {
      return (
        (await replicaClient.execute("SELECT COUNT(*) AS count FROM cloud_teams")).rows[0]
          ?.count === 25
      );
    } catch {
      return false;
    }
  });
  assert.equal((await peer.listTeamsByEvent(event.eventId)).length, 25);
  const replicaUniqueDiagnostic = await duplicateCreation();
  const burst = await readBurst();
  const native = await nativeBattle(team);
  const rotated = "Z".repeat(43);
  assert.equal(
    await repository.rotateTeamAccess(team, rotated, new Date(now + 1).toISOString()),
    "updated",
  );
  assert.equal(await peer.authenticateTeam(team.teamLoginKey, now), undefined);
  assert.equal((await peer.authenticateTeam(rotated, now))?.teamId, team.teamId);
  await assert.rejects(
    () => new SqlDeploymentsCoordination(replicaSql).request(native.leak),
    /unauthorized/u,
  );
  await eventually(
    async () =>
      (await replicaClient.execute("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"))
        .rows[0]?.count === 26,
  );
  await primary.stop();
  primary = undefined;
  assert.equal(
    (await replicaClient.execute("SELECT COUNT(*) AS count FROM cloud_teams")).rows[0]?.count,
    25,
  );
  const outageClient = localClient(replicaPort, 2000);
  try {
    // SELECT remains replica-local, but repository authority reads must fail
    // closed when the primary cannot execute their zero-row UPDATE + SELECT.
    await assert.rejects(() =>
      new SqlCloudRepository(new LibsqlExecutor(outageClient)).authenticateTeam(rotated, now),
    );
  } finally {
    outageClient.close();
  }
  primary = await startSqld(binary.path, primaryPath, primaryPort, primaryOptions);
  await initializeControlDataSchema(primaryClient);
  assert.deepEqual(
    await repository.replayEventCreation(receipt.scope, receipt.key, receipt.requestHash),
    receipt.response,
  );
  assert.equal((await repository.authenticateTeam(rotated, now))?.authVersion, 2);
  const restarted = new SqlDeploymentsCoordination(primarySql);
  const persisted = await restarted.read(event.eventId, native.artifact.problemId);
  assert.deepEqual(persisted, native.after);
  const freshTeam = await repository.getTeam(event.eventId, team.teamId);
  assert.ok(freshTeam);
  assertSameJson(await restarted.request({ ...native.leak, team: freshTeam }), native.result);
  assert.equal(
    (await restarted.listScoreEvents(event.eventId, native.artifact.problemId, team.teamId)).length,
    1,
  );
  await primarySql.run("CREATE TABLE unrelated_application (id INTEGER PRIMARY KEY)");
  await primarySql.run("INSERT INTO unrelated_application VALUES (1)");
  await resetControlData(primarySql);
  assert.equal((await repository.listEvents()).length, 0);
  assert.equal(
    (await primarySql.get("SELECT COUNT(*) AS count FROM unrelated_application"))?.count,
    1,
  );
  assert.equal((await primarySql.get("SELECT version FROM cloud_schema WHERE id = 1"))?.version, 1);
  console.log(
    JSON.stringify({
      outcome: "passed",
      server: binary.version,
      serverSha256: binary.sha256,
      target:
        "official local sqld primary and replica; real HTTP; synthetic data; not hosted Turso",
      teams: 25,
      concurrentAuthenticationReads: 100,
      replicaUniqueDiagnostic,
      ...burst,
      nativeCryptoBattle: {
        readyOperations: 25,
        concurrentProjectionReads: 100,
        receiptCountBeforeReset: 26,
        firstLeakAward: native.award,
        lateCasRollback: "passed",
        exactlyOnceScoreAndReceipt: "passed",
      },
      authority:
        "rotation rejects old key/replay; replica SELECT works during primary outage while repository authentication fails closed",
      restartDurability:
        "creation receipt, native snapshot, rotated access, score ledger and operation receipt survived process restart",
      scopedReset: "control data removed; schema and unrelated table preserved",
      unverified:
        "hosted Turso service, production latency/capacity, WAN replication faults, real cloud resources",
    }),
  );
} finally {
  for (const client of clients) client.close();
  await replica?.stop();
  await primary?.stop();
  rmSync(directory, { recursive: true, force: true });
}
