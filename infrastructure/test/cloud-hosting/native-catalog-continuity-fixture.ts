import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, vi } from "vitest";
import type {
  CloudDataRepository,
  CloudDeploymentsCoordination,
} from "../../lib/problem-deploy/control-data/cloud-data-ports.js";
import type { NativeCoordinationRun } from "../../lib/problem-deploy/control-data/domain/coordination.js";
import { contentDigest } from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  nativeArtifact,
  nativeParticipantProblems,
  settleNativeEvent,
} from "../../lib/problem-deploy/handlers/cloud-api/coordination-routes.js";
import { createProductionNativeCoordination } from "../../lib/problem-deploy/handlers/cloud-api/native-production.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const PROBLEM = "ac26-crypto-battle";
interface Fixture {
  readonly repository: Pick<CloudDataRepository, "getEvent" | "listTeamScores">;
  readonly store: CloudDeploymentsCoordination;
  readonly event: EventRecord;
  readonly teams: TeamRecord[];
  readonly team: TeamRecord;
}

function reviewedCatalog(version: "A" | "B", description: string) {
  const source = `export default {
    stateSchemaVersion: ${version === "A" ? 1 : 2},
    migrateState: s => s,
    initialState: ctx => Object.fromEntries(ctx.teamIds.map(id => [id, ${version === "A" ? 7 : 70}])),
    validateOp: () => ({ ok: true }),
    applyOp: s => Object.fromEntries(Object.entries(s).map(([id, value]) => [id, value + ${version === "A" ? 3 : 30}])),
    projectForTeam: (s, id) => ({ score: s[id], version: "${version}" }),
    teamScores: s => s
  };`;
  const artifactDigest = contentDigest(source);
  const descriptor = {
    kind: "coordination",
    problemId: PROBLEM,
    problemDir: "problems/battles/ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    stateBudget: { baseBytes: 1536, bytesPerTeam: 31744 },
    name: "Saved native game",
    description,
    instructions: "Play",
  };
  const raw = JSON.stringify({ version: 1, problems: [], nativeProblems: [descriptor] });
  const catalogKey = `catalogs/${contentDigest(raw)}.json`;
  return { descriptor, catalogKey, raw, source };
}

function production(f: Fixture, catalogKey: string) {
  return createProductionNativeCoordination({
    repository: f.repository,
    store: f.store,
    artifactBucket: "synthetic-artifacts",
    region: "us-east-1",
    expectedBucketOwner: "123456789012",
    catalogKey,
  });
}

async function readRun(f: Fixture): Promise<NativeCoordinationRun> {
  const run = await f.store.read(f.event.eventId, PROBLEM);
  if (!run) throw new Error("Missing initialized run");
  return run;
}

async function expectScores(f: Fixture, score: number) {
  expect(await f.repository.listTeamScores(f.event.eventId)).toEqual(
    expect.arrayContaining(
      f.teams.map((team) => ({
        eventId: f.event.eventId,
        teamId: team.teamId,
        score,
        completedProblems: 2,
      })),
    ),
  );
}

/** Uses production resolution and adapters, with transport interception supplied by each fixture. */
export async function verifySavedNativeCatalog(
  createFixture: () => Fixture | Promise<Fixture>,
  update: "description-only" | "changed bundle",
) {
  const old = reviewedCatalog("A", "Original display copy");
  const current = reviewedCatalog(update === "description-only" ? "A" : "B", "New display copy");
  const objects = new Map([
    [old.catalogKey, old.raw],
    [old.descriptor.pluginKey, old.source],
    [current.catalogKey, current.raw],
    [current.descriptor.pluginKey, current.source],
  ]);
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 command");
    expect(command.input.Bucket).toBe("synthetic-artifacts");
    expect(command.input.ExpectedBucketOwner).toBe("123456789012");
    const raw = objects.get(command.input.Key ?? "");
    if (raw === undefined) throw new Error("Unexpected artifact key");
    return { ContentLength: Buffer.byteLength(raw), Body: { transformToString: async () => raw } };
  });
  const f = await createFixture();
  const original = production(f, old.catalogKey);
  const artifact = await nativeArtifact(original, {
    ...old.descriptor,
    catalogKey: old.catalogKey,
  });
  const first = await f.store.initialize({ event: f.event, teams: f.teams, artifact, now: NOW });
  await expectScores(f, 107);
  const operation = {
    key: "saved-operation-one",
    hash: contentDigest("score"),
    op: { kind: "score" },
    runId: first.runId,
  };
  const response = await f.store.request({
    event: f.event,
    team: f.team,
    artifact,
    operation,
    now: () => NOW,
  });
  const saved = await readRun(f);
  expect(response.body).toEqual({ projection: { score: 10, version: "A" } });
  await expectScores(f, 110);

  // A fresh production factory simulates the rollout of catalog B against persisted run A.
  const deployed = production(f, current.catalogKey);
  const retained = await nativeArtifact(deployed, saved);
  const request = (move?: typeof operation) =>
    f.store.request({
      event: f.event,
      team: f.team,
      artifact: retained,
      operation: move,
      now: () => NOW + 1000,
    });
  expect((await request()).body).toEqual(response.body);
  expect(await request(operation)).toEqual(response);
  expect(await readRun(f)).toEqual(saved);
  await expectScores(f, 110);
  expect(
    await f.store.initialize({
      event: f.event,
      teams: f.teams,
      artifact: retained,
      now: NOW + 1000,
    }),
  ).toEqual(saved);
  expect(await nativeParticipantProblems(deployed, f.event, f.team)).toMatchObject([
    { jobId: first.runId, score: 10, description: old.descriptor.description },
  ]);
  expect((await request({ ...operation, key: "saved-operation-two" })).body).toEqual({
    projection: { score: 13, version: "A" },
  });
  await expectScores(f, 113);
  const played = await readRun(f);
  expect(await f.store.listScoreEvents(f.event.eventId, PROBLEM, f.team.teamId)).toHaveLength(3);

  const locked = await settleNativeEvent(deployed, f.event, () => NOW + 2000, {
    scoringLocked: true,
  });
  expect(locked?.scoringLocked).toBe(true);
  const unlocked = await settleNativeEvent(deployed, locked as EventRecord, () => NOW + 3000, {
    scoringLocked: false,
  });
  if (!unlocked) throw new Error("Missing updated event");
  const scheduled = await readRun(f);
  expect(scheduled.match).toEqual({ ...played.match, version: played.match.version + 2 });
  await expectScores(f, 113);
  const reset = await f.store.reset({
    event: unlocked,
    artifact: await nativeArtifact(deployed, scheduled),
    expectedRunId: first.runId,
    now: () => NOW + 4000,
  });
  const restarted = await readRun(f);
  expect(reset.previousRunId).toBe(first.runId);
  expect(reset.runId).not.toBe(first.runId);
  expect(restarted).toMatchObject({
    catalogKey: old.catalogKey,
    artifactDigest: old.descriptor.artifactDigest,
    pluginKey: old.descriptor.pluginKey,
    roster: first.roster,
    history: [first.runId],
    match: { stateSchemaVersion: 1, state: first.match.state, scores: first.match.scores },
  });
  expect(restarted.match.matchSecret).not.toBe(first.match.matchSecret);
  expect(await f.store.readRun(f.event.eventId, PROBLEM, first.runId)).toMatchObject({
    ...scheduled,
    closed: true,
  });
  await expectScores(f, 107);
  await expect(request(operation)).rejects.toThrow("coordination_run_changed");

  const closed = await deployed.closeEvent(f.event.eventId, NOW + 5000);
  expect(closed).toMatchObject({ status: "TEARDOWN", scoringLocked: true });
  expect(await readRun(f)).toMatchObject({
    runId: reset.runId,
    closed: true,
    match: { ...restarted.match, version: restarted.match.version + 1 },
  });
  await expectScores(f, 107);
  await expect(
    f.store.request({
      event: closed,
      team: f.team,
      artifact: retained,
      operation: { ...operation, key: "closed-operation", runId: reset.runId },
      now: () => NOW + 6000,
    }),
  ).rejects.toThrow("event_ended");
  await expect(
    f.store.reset({
      event: closed,
      artifact: retained,
      expectedRunId: reset.runId,
      now: () => NOW + 6000,
    }),
  ).rejects.toThrow("event_ended");
  expect(
    send.mock.calls.some(
      ([command]) =>
        command instanceof GetObjectCommand && command.input.Key === current.catalogKey,
    ),
  ).toBe(false);

  const fresh = await createFixture();
  const freshApi = production(fresh, current.catalogKey);
  const descriptor = (await freshApi.catalog())[PROBLEM];
  if (!descriptor) throw new Error("Missing current native problem");
  const freshArtifact = await nativeArtifact(freshApi, descriptor);
  const freshRun = await fresh.store.initialize({
    event: fresh.event,
    teams: fresh.teams,
    artifact: freshArtifact,
    now: NOW,
  });
  expect(freshRun).toMatchObject({
    catalogKey: current.catalogKey,
    artifactDigest: current.descriptor.artifactDigest,
    match: { stateSchemaVersion: update === "description-only" ? 1 : 2 },
  });
  await expectScores(fresh, update === "description-only" ? 107 : 170);
}
