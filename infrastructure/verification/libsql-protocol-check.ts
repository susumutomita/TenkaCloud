/** Explicit local-only rehearsal of the restored SQL repositories with the official HTTP client. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { resetKnownTursoData } from "../../scripts/cloud-hosting/turso-reset.js";
import { assertTursoSchemaCompatible } from "../../scripts/cloud-hosting/turso-schema.js";
import type { DeploymentRecord } from "../lib/problem-deploy/control-data/domain/deployments.js";
import type { EventRecord } from "../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlDeploymentsRepository } from "../lib/problem-deploy/control-data/sql-deployments-repository.js";
import { SqlEventsRepository } from "../lib/problem-deploy/control-data/sql-events-repository.js";
import { SqlTeamsRepository } from "../lib/problem-deploy/control-data/sql-teams-repository.js";
import { freePort, installedSqld, localClient, startSqld } from "./official-sqld.js";

assert.equal(
  process.argv.length,
  3,
  "Pass one absolute path to an installed official sqld binary.",
);
const binary = installedSqld(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), "tenkacloud-restored-sql-"));
const port = await freePort();
let server: Awaited<ReturnType<typeof startSqld>> | undefined;
const client = localClient(port);
const sql = new LibsqlExecutor(client);
const events = new SqlEventsRepository(sql);
const teams = new SqlTeamsRepository(sql);
const deployments = new SqlDeploymentsRepository(sql);
const at = new Date().toISOString();
const expiresAt = Math.floor(Date.now() / 1000) + 86400;
const event: EventRecord = {
  eventId: "rehearsal-event",
  tenantId: "local",
  name: "Synthetic competition",
  status: "READY",
  teamCount: 25,
  problems: [{ problemId: "http-query", defaultRegion: "us-east-1" }],
  createdAt: at,
  updatedAt: at,
  expiresAt,
};
const teamRows: TeamRecord[] = Array.from({ length: 25 }, (_, i) => ({
  eventId: event.eventId,
  tenantId: "local",
  teamId: `team-${i}`,
  internalSlug: `team-${i}`,
  teamLoginKey: `synthetic-local-rehearsal-${i}`,
  createdAt: at,
  updatedAt: at,
  expiresAt,
}));
const first = teamRows[0];
assert.ok(first?.teamLoginKey);

try {
  server = await startSqld(binary.path, join(directory, "database"), port);
  await assertTursoSchemaCompatible(client);
  await initializeControlDataSchema(client);
  assert.equal((await events.createEventWithTeams(event, teamRows)).outcome, "created");
  assert.equal((await events.createEventWithTeams(event, teamRows)).outcome, "conflict");
  const maximum: EventRecord = { ...event, eventId: "maximum-event", teamCount: 99 };
  const maxTeams = Array.from(
    { length: 99 },
    (_, i): TeamRecord => ({
      ...first,
      eventId: maximum.eventId,
      teamId: `max-${i}`,
      internalSlug: `max-${i}`,
      teamLoginKey: `synthetic-max-${i}`,
    }),
  );
  assert.equal((await events.createEventWithTeams(maximum, maxTeams)).outcome, "created");
  assert.equal((await teams.listTeamsByEvent(maximum.eventId)).length, 99);
  for (const team of teamRows) {
    const job: DeploymentRecord = {
      jobId: `job-${team.teamId}`,
      tenantId: "local",
      eventId: event.eventId,
      teamId: team.teamId,
      problemId: "http-query",
      awsAccountId: "123456789012",
      region: "us-east-1",
      teamName: team.internalSlug,
      namePrefix: `synthetic-${team.teamId}`,
      teamLoginKey: team.teamLoginKey,
      status: "COMPLETE",
      score: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt,
    };
    await deployments.putDeployment(job);
  }
  const latencies: number[] = [];
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const team = teamRows[i % teamRows.length];
      assert.ok(team?.teamLoginKey);
      const start = performance.now();
      const rows = await deployments.listByTeamLoginKey(team.teamLoginKey);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.teamId, team.teamId);
      latencies.push(performance.now() - start);
    }),
  );
  const jobId = `job-${first.teamId}`;
  const hint = { hintId: "hint-1", penaltyApplied: 20, revealedAt: at };
  const hints = await Promise.all([
    deployments.applyHintPenalty(jobId, hint, at),
    deployments.applyHintPenalty(
      jobId,
      { ...hint, revealedAt: new Date(Date.now() + 1).toISOString() },
      at,
    ),
  ]);
  assert.equal(hints.filter((x) => x.outcome === "updated").length, 1);
  const solved = await Promise.all([
    deployments.applyFlagCorrectScore(jobId, 200, at),
    deployments.applyFlagCorrectScore(jobId, 200, at),
  ]);
  assert.equal(solved.filter((x) => x.outcome === "updated").length, 1);
  assert.equal((await deployments.getDeployment(jobId))?.score, 180);
  assert.equal(
    (
      await teams.rotateLoginKey({
        tenantId: "local",
        eventId: event.eventId,
        teamId: first.teamId,
        newLoginKey: "synthetic-rotated-key",
        expectedUpdatedAt: at,
        updatedAt: new Date(Date.now() + 2).toISOString(),
        deployments: [{ jobId, createdAt: at }],
      })
    ).outcome,
    "updated",
  );
  assert.equal((await deployments.listByTeamLoginKey(first.teamLoginKey)).length, 0);
  assert.equal((await deployments.listByTeamLoginKey("synthetic-rotated-key")).length, 1);
  await server.stop();
  server = await startSqld(binary.path, join(directory, "database"), port);
  await initializeControlDataSchema(client);
  assert.equal((await deployments.getDeployment(jobId))?.score, 180);
  assert.equal((await teams.listTeamsByEvent(event.eventId)).length, 25);
  await sql.run("CREATE TABLE unrelated (value TEXT)");
  await sql.run("INSERT INTO unrelated VALUES ('preserve')");
  await resetKnownTursoData(client, "lite-baseline-v1");
  assert.equal((await events.listEventsByTenant("local")).length, 0);
  assert.equal((await sql.get("SELECT value FROM unrelated"))?.value, "preserve");
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(latencies[Math.ceil(latencies.length * p) - 1] ?? 0);
  console.log(
    JSON.stringify(
      {
        outcome: "passed",
        server: binary.version,
        serverSha256: binary.sha256,
        target: "official local sqld; synthetic data; not hosted Turso or AWS",
        teams: 25,
        maximumTeams: 99,
        concurrentAuthenticationReads: 100,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        hintAndScoreExactlyOnce: true,
        rotationRevokesOldKey: true,
        restartPreservesState: true,
        explicitResetPreservesUnrelatedTables: true,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
  await server?.stop();
  rmSync(directory, { recursive: true, force: true });
}
