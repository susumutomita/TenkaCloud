import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/types.js";
import { resetCoordinationRun } from "../../lib/problem-deploy/handlers/event-handler/coordination-reset.js";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared.js";
import { createCoordinationTickPass } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";
import { readCoordinationState } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import {
  handleCoordinationTickBatch,
  parseCoordinationTickBatch,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import { startCoordinationRun } from "../../lib/problem-deploy/handlers/shared/coordination-run.js";
import {
  COORDINATION_TICK_ACTION,
  type CoordinationTickBatch,
} from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

const key = { tenantId: "tenant", eventId: "event", problemId: "battle" };
const endsAt = "2026-09-06T01:00:00.000Z";
const acceptedAt = "2026-09-06T00:59:59.999Z";
const materializedAt = "2026-09-06T01:01:00.000Z";
const deployment: DeploymentRecord = {
  ...key,
  jobId: "job-red",
  teamId: "red",
  teamName: "Red",
  teamLoginKey: "login",
  namePrefix: "red",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  status: "COMPLETE",
  createdAt: acceptedAt,
  updatedAt: acceptedAt,
  eventStartsAt: "2026-09-06T00:00:00.000Z",
  eventEndsAt: endsAt,
  score: 230,
  coordinationSubtotal: 30,
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(backend: string, scores = true) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const repository =
    backend === "DynamoDB"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  const runtime = {
    ...makeTestControlDataRuntime({
      CONTROL_DATA_BACKEND: backend === "DynamoDB" ? "dynamodb" : "turso",
    }),
    resolveDeploymentsRepository: async () => repository,
    resolveEventsRepository: async () => ({
      getEvent: async () => ({ status: "RUNNING", startsAt: deployment.eventStartsAt, endsAt }),
    }),
  };
  const store = {
    runtime,
    ddb,
    tableName: "Deployments",
    coordinationScoreModes: { battle: "additive" as const },
  };
  await repository.putDeployment(deployment);
  const initialState = vi.fn((ctx: { teamIds: readonly string[] }) => ({
    scores: Object.fromEntries(ctx.teamIds.map((id) => [id, 17])),
  }));
  const tick = vi.fn((state: unknown) => state);
  const plugin: CoordinationPlugin<unknown, unknown> = {
    initialState,
    tick,
    validateOp: () => ({ ok: true }),
    applyOp: (state) => state,
    projectForTeam: (state) => state,
    ...(scores
      ? { teamScores: (state: unknown) => (state as { scores: Record<string, number> }).scores }
      : {}),
  };
  const importer = vi.fn(async () => ({ default: plugin }));
  const deps = { store, importer, config: { battle: { plugin: "battle" } } };
  const shared = {
    ...store,
    deploymentsTableName: "Deployments",
    eventsTableName: "Events",
  } as unknown as EventSharedResources;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(acceptedAt);
  const reset = await resetCoordinationRun(shared, key.tenantId, key.eventId, key.problemId);
  expect(reset.kind).toBe("ok");
  if (reset.kind !== "ok") throw new Error("Reset failed");
  const scope = { ...key, runId: reset.result.runId };
  vi.setSystemTime(materializedAt);
  const batch: CoordinationTickBatch = {
    action: COORDINATION_TICK_ACTION,
    nowIso: materializedAt,
    targets: [
      {
        tenantId: key.tenantId,
        eventId: key.eventId,
        moduleRef: key.problemId,
        eventNowMs: 0,
        teamIds: [],
        drainOnly: true,
        initializeRunId: scope.runId,
      },
    ],
  };
  return { repository, sql, ddb, store, deps, scope, batch, initialState, tick, importer };
}

describe.each(["DynamoDB", "SQL"])("accepted reset initialization: %s", (backend) => {
  it.each([
    "COMPLETE",
    "DELETED",
  ] as const)("fulfils a reset accepted one millisecond before end through scheduled recovery, once (deployment=%s)", async (status) => {
    const ctx = await setup(backend);
    await ctx.repository.putDeployment({ ...deployment, status });
    expect(await ctx.repository.readCoordinationRun(key)).toMatchObject({
      pendingInitialization: true,
    });
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toBeUndefined();
    const invoke = vi.fn(async (_name: string, batch: CoordinationTickBatch) => {
      const parsed = parseCoordinationTickBatch(batch);
      expect(parsed).not.toBeNull();
      if (parsed) await handleCoordinationTickBatch(ctx.deps, parsed);
    });
    const pass = createCoordinationTickPass(
      invoke,
      "dispatcher",
      new Set(["battle"]),
      ctx.repository,
    );
    await ctx.repository.forEachCompleteDeploymentPage(
      async (items) => pass.collect(items, materializedAt),
      async (scopes) => pass.collectRecovery(scopes),
    );
    pass.collectRecovery([ctx.scope]);
    await pass.run(Date.parse(materializedAt), materializedAt);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.initialState).toHaveBeenCalledWith(
      expect.objectContaining({ teamIds: ["red"], teamNames: { red: "Red" } }),
    );
    expect(ctx.tick).not.toHaveBeenCalled();
    expect(await ctx.repository.getDeployment(deployment.jobId)).toMatchObject({
      score: 217,
      coordinationSubtotal: 17,
    });
    expect(await ctx.repository.listScoreEvents(deployment.jobId, { pageSize: 100 })).toEqual([
      expect.objectContaining({ points: -13, occurredAt: acceptedAt, reason: "sync" }),
    ]);
    expect((await ctx.repository.readCoordinationRun(key))?.pendingInitialization).toBeUndefined();
    expect((await readCoordinationState(ctx.store, ctx.scope))?.pendingScores).toBeUndefined();
    await handleCoordinationTickBatch(ctx.deps, ctx.batch);
    await pass.run(Date.parse(materializedAt), materializedAt);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    await ctx.repository.sweepExpiredCoordinationState(
      Math.floor(Date.parse(materializedAt) / 1000) + 8 * 86400,
    );
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toBeUndefined();
    await handleCoordinationTickBatch(ctx.deps, ctx.batch);
    await pass.run(Date.parse(materializedAt), materializedAt);
    expect(ctx.importer).toHaveBeenCalledTimes(1);
    expect(await ctx.repository.readCoordinationMatchSecret(ctx.scope)).toBeUndefined();
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toBeUndefined();
  });
  it("keeps the obligation when roster reads fail or return no teams, then recovers", async () => {
    const ctx = await setup(backend);
    const roster = vi.spyOn(ctx.repository, "listByTenantAndEvent");
    roster.mockRejectedValueOnce(new Error("roster unavailable"));
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(0);
    roster.mockResolvedValueOnce([]);
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(0);
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(await ctx.repository.readCoordinationMatchSecret(ctx.scope)).toBeUndefined();
    expect((await ctx.repository.readCoordinationRun(key))?.pendingInitialization).toBe(true);
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(1);
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
  });
  it("rolls back the pointer's consumed flag when the initial-state transaction fails, then retries", async () => {
    const ctx = await setup(backend);
    if (backend === "DynamoDB") {
      const send = ctx.ddb.send.bind(ctx.ddb);
      const originalWrite = ctx.repository.writeCoordinationState.bind(ctx.repository);
      vi.spyOn(ctx.repository, "writeCoordinationState").mockImplementationOnce(async (...args) => {
        vi.spyOn(ctx.ddb, "send").mockImplementationOnce((command: unknown) => {
          if (!(command instanceof TransactWriteCommand))
            throw new Error("Expected state transaction");
          return send(
            new TransactWriteCommand({
              ...command.input,
              TransactItems: [
                ...(command.input.TransactItems ?? []),
                {
                  ConditionCheck: {
                    TableName: "Deployments",
                    Key: { PK: "fixture", SK: "failure" },
                    ConditionExpression: "attribute_exists(PK)",
                  },
                },
              ],
            }),
          );
        });
        return originalWrite(...args);
      });
    } else {
      const batch = ctx.sql.batch.bind(ctx.sql);
      vi.spyOn(ctx.sql, "batch").mockImplementationOnce((statements) =>
        batch([
          ...statements,
          {
            sql: "INSERT INTO deployment_score_events (job_id, sk, record_type, payload) VALUES ('failure', '', NULL, '{}')",
          },
        ]),
      );
    }
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(0);
    expect((await ctx.repository.readCoordinationRun(key))?.pendingInitialization).toBe(true);
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toBeUndefined();
    expect((await ctx.repository.getDeployment(deployment.jobId))?.score).toBe(230);
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(1);
    expect((await ctx.repository.getDeployment(deployment.jobId))?.score).toBe(217);
    expect(await ctx.repository.listScoreEvents(deployment.jobId, { pageSize: 100 })).toHaveLength(
      1,
    );
    expect(ctx.initialState.mock.calls[0]?.[0]).toEqual(ctx.initialState.mock.calls[1]?.[0]);
  });
  it("consumes an accepted initialization even when the plugin has no score hook", async () => {
    const ctx = await setup(backend, false);
    expect((await handleCoordinationTickBatch(ctx.deps, ctx.batch)).written).toBe(1);
    expect((await ctx.repository.readCoordinationRun(key))?.pendingInitialization).toBeUndefined();
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toMatchObject({ version: 1 });
    await handleCoordinationTickBatch(ctx.deps, ctx.batch);
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
  });
  it("rejects another reset until the accepted obligation has been materialized", async () => {
    const ctx = await setup(backend);
    expect(await startCoordinationRun({ repository: ctx.repository }, key, materializedAt)).toEqual(
      { kind: "conflict" },
    );
    expect(
      await ctx.repository.rotateCoordinationRun(
        key,
        ctx.scope.runId,
        {
          runId: "r-next",
          startedAt: materializedAt,
          history: [ctx.scope.runId],
          pendingInitialization: true,
        },
        0,
      ),
    ).toEqual({ outcome: "conflict" });
    expect((await ctx.repository.readCoordinationRun(key))?.runId).toBe(ctx.scope.runId);
  });
  it("enforces the pending intent in the state transaction even after TTL removes the first state", async () => {
    const ctx = await setup(backend, false);
    expect(
      await ctx.repository.writeCoordinationState(
        ctx.scope,
        { initial: 17 },
        0,
        materializedAt,
        1,
        true,
      ),
    ).toEqual({ outcome: "updated" });
    await ctx.repository.sweepExpiredCoordinationState(2);
    expect(
      await ctx.repository.writeCoordinationState(
        ctx.scope,
        { stale: 17 },
        0,
        materializedAt,
        1,
        true,
      ),
    ).toEqual({ outcome: "conflict" });
    expect(await ctx.repository.readCoordinationState(ctx.scope)).toBeUndefined();
  });
  it("does not let a stale run initialization consume a different run's intent", async () => {
    const ctx = await setup(backend, false);
    await handleCoordinationTickBatch(ctx.deps, ctx.batch);
    const next = await startCoordinationRun(
      { repository: ctx.repository },
      key,
      materializedAt,
      "r-next",
    );
    expect(next.kind).toBe("started");
    await handleCoordinationTickBatch(ctx.deps, ctx.batch);
    expect(
      await ctx.repository.writeCoordinationState(ctx.scope, {}, 0, materializedAt, 1, true),
    ).toEqual({ outcome: "conflict" });
    expect(await ctx.repository.readCoordinationRun(key)).toMatchObject({
      runId: "r-next",
      pendingInitialization: true,
    });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
  });
});
