import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import type { CoordinationStateScope } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import {
  DynamoDbEventsRepository,
  SqlEventsRepository,
} from "../../lib/problem-deploy/control-data/events-repository.js";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/types.js";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete.js";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy.js";
import { bulkTeardownEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-delete.js";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared.js";
import { createCoordinationTickPass } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";
import type { CoordinationTickInvoker } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick-dispatch.js";
import { dispatchCoordinationOp } from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import {
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { handleCoordinationTickBatch } from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import * as artifactRuntime from "../../lib/problem-deploy/handlers/shared/coordination-artifact-store.js";
import { cleanupCoordinationStateIfLastDeployment } from "../../lib/problem-deploy/handlers/shared/coordination-cleanup.js";
import {
  deleteAllCoordinationRuns,
  startCoordinationRun,
} from "../../lib/problem-deploy/handlers/shared/coordination-run.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";
import { fakeArtifactStore } from "./coordination.test-helpers.js";

const at = "2026-09-06T00:00:00.000Z";
const teardownAt = "2026-09-06T00:01:00.000Z";
const key = { tenantId: "tenant", eventId: "event", problemId: "battle" };
const plugin: CoordinationPlugin<number, { kind: "solve" }, number> = {
  initialState: () => 0,
  validateOp: (score) => (score === 0 ? { ok: true } : { ok: false, error: "already_solved" }),
  applyOp: () => 30,
  projectForTeam: (score) => score,
  teamScores: (score) => ({ red: score }),
  scoreReasons: () => ({ red: "cipher" }),
};

async function setup(backend: string) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const repository =
    backend === "SQL"
      ? new SqlDeploymentsRepository(sql)
      : new DynamoDbDeploymentsRepository(ddb, "Deployments");
  const eventRepository =
    backend === "SQL" ? new SqlEventsRepository(sql) : new DynamoDbEventsRepository(ddb, "Events");
  await eventRepository.putEvent({
    tenantId: key.tenantId,
    eventId: key.eventId,
    name: "Fixture",
    status: "ENDED",
    teamCount: 1,
    createdAt: at,
    updatedAt: at,
    expiresAt: 0,
    problems: [],
  });
  await repository.putDeployment({
    ...key,
    jobId: "red",
    teamId: "red",
    teamName: "Red",
    teamLoginKey: "fixture-key",
    namePrefix: "fixture-red",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    status: "COMPLETE",
    createdAt: at,
    updatedAt: at,
    score: 0,
  });
  const runtime = {
    ...makeTestControlDataRuntime(),
    resolveDeploymentsRepository: async () => repository,
    resolveEventsRepository: async () => eventRepository,
  };
  const store = {
    runtime,
    ddb,
    tableName: "Deployments",
    coordinationScoreModes: { battle: "exclusive" as const },
  };
  const scope = { ...key, runId: "retained-run" };
  expect(await startCoordinationRun({ repository }, key, at, scope.runId)).toMatchObject({
    kind: "started",
  });
  expect(await writeCoordinationState(store, scope, 0, 0, at)).toEqual({ kind: "ok" });
  await repository.ensureCoordinationMatchSecret(scope, "fixture-secret", 0);
  const artifacts = fakeArtifactStore();
  const deleteArtifacts = vi.spyOn(artifacts, "deleteScope");
  vi.spyOn(artifactRuntime, "resolveCoordinationArtifactStore").mockReturnValue(artifacts);
  const send = vi.fn(async (_command: PutEventsCommand) => ({
    FailedEntryCount: 0,
    Entries: [{ EventId: "fixture" }],
  }));
  const shared: EventSharedResources & DeploySharedResources = {
    runtime,
    ddb,
    tableName: "Deployments",
    deploymentsTableName: "Deployments",
    eventsTableName: "Events",
    teamsTableName: "Teams",
    competitorAccountsTableName: "Accounts",
    env: "development",
    eventBusName: "fixture-bus",
    problemsCatalog: {},
    events: { send } as unknown as EventSharedResources["events"],
  };
  const input = {
    scope,
    teamId: "red",
    ctx: { eventId: key.eventId, teamIds: ["red"] },
    op: { kind: "solve" as const },
    fallbackProjection: 0,
    nowIso: at,
  };
  return { repository, store, scope, shared, send, input, artifacts, deleteArtifacts, sql };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["DynamoDB", "SQL"])("teardown retains committed score history: %s", (backend) => {
  it.each([
    "bulk",
    "single",
  ])("continues %s resource teardown during delivery failure, then settles the deleted deployment exactly once", async (mode) => {
    const { repository, store, scope, shared, send, input, artifacts, deleteArtifacts } =
      await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValue(new Error("delivery backend unavailable"));
    expect(await dispatchCoordinationOp(store, plugin, input)).toEqual({
      kind: "ok",
      projection: 30,
    });
    const pending = await readCoordinationState(store, scope);
    expect(pending?.pendingScores).toMatchObject({ teams: { red: { before: 0, score: 30 } } });
    if (mode === "bulk") {
      expect(
        await bulkTeardownEvent(shared, key.tenantId, key.eventId, Date.parse(teardownAt)),
      ).toEqual({
        kind: "ok",
        result: { eventId: key.eventId, enqueued: 1, skipped: 0, failed: 0 },
      });
    } else {
      expect(await requestTeardown(shared, key.tenantId, "red", Date.parse(teardownAt))).toEqual({
        kind: "accepted",
        previousStatus: "COMPLETE",
      });
    }
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
    expect((await repository.getDeployment("red"))?.status).toBe("DELETING");
    expect(await readCoordinationState(store, scope)).toEqual(pending);
    expect((await repository.readCoordinationRun(key))?.runId).toBe(scope.runId);
    expect(await repository.readCoordinationMatchSecret(scope)).toBe("fixture-secret");
    expect(deleteArtifacts).not.toHaveBeenCalled();
    expect(await cleanupCoordinationStateIfLastDeployment({ repository, artifacts }, key)).toEqual({
      kind: "pending_scores",
    });
    // Cloud teardown completes while score delivery is still down.
    await repository.markDeleted("red", teardownAt);
    publish.mockRestore();
    const importer = vi.fn(async () => ({ default: plugin }));
    const invoke = vi.fn<CoordinationTickInvoker>(async (_functionName, batch) => {
      await handleCoordinationTickBatch(
        { store, importer, config: { battle: { plugin: "battle" } } },
        batch,
      );
    });
    const scanAndDrain = async () => {
      // A fresh pass per scheduled invocation: no state from the preceding scan.
      const pass = createCoordinationTickPass(
        invoke,
        "fixture-dispatcher",
        new Set([key.problemId]),
        repository,
      );
      const complete: DeploymentRecord[] = [];
      const recovery: CoordinationStateScope[] = [];
      await repository.forEachCompleteDeploymentPage(
        async (items) => {
          complete.push(...items);
          pass.collect(items, teardownAt);
        },
        async (scopes) => {
          recovery.push(...scopes);
          pass.collectRecovery(scopes);
        },
      );
      // Only the durable recovery marker can find this event; no COMPLETE row remains.
      expect(complete).toEqual([]);
      await pass.run(Date.parse(teardownAt), teardownAt);
      return recovery;
    };
    expect(await scanAndDrain()).toEqual([scope]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[1].targets).toEqual([
      expect.objectContaining({
        tenantId: key.tenantId,
        eventId: key.eventId,
        moduleRef: key.problemId,
        drainOnly: true,
      }),
    ]);
    expect(importer).not.toHaveBeenCalled();
    const settled = await readCoordinationState(store, scope);
    expect(settled).toMatchObject({
      state: pending?.state,
      version: pending?.version,
      expiresAt: pending?.expiresAt,
    });
    expect(settled?.pendingScores).toBeUndefined();
    expect(await scanAndDrain()).toEqual([]);
    expect(invoke).toHaveBeenCalledOnce();
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect((await repository.getDeployment("red"))?.status).toBe("DELETED");
    const history = await repository.listScoreEvents("red", { pageSize: 100 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ occurredAt: at, points: 30 });
    expect(
      await cleanupCoordinationStateIfLastDeployment({ repository, artifacts }, key),
    ).toMatchObject({ kind: "deleted" });
    expect(await readCoordinationState(store, scope)).toBeUndefined();
    expect(await repository.readCoordinationRun(key)).toMatchObject({
      runId: scope.runId,
      closed: true,
    });
    expect(await repository.readCoordinationMatchSecret(scope)).toBeUndefined();
  });

  it("keeps an accepted reset's initialization obligation while resource teardown proceeds", async () => {
    const { repository, shared, send, deleteArtifacts } = await setup(backend);
    expect(await startCoordinationRun({ repository }, key, at, "pending-run")).toMatchObject({
      kind: "started",
    });
    expect((await repository.readCoordinationRun(key))?.pendingInitialization).toBe(true);
    expect(
      await bulkTeardownEvent(shared, key.tenantId, key.eventId, Date.parse(teardownAt)),
    ).toMatchObject({
      kind: "ok",
      result: { enqueued: 1, failed: 0 },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(await repository.readCoordinationRun(key)).toMatchObject({
      runId: "pending-run",
      pendingInitialization: true,
    });
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("dispatches resource deletion before waiting on coordination cleanup", async () => {
    const { repository, shared, send } = await setup(backend);
    const pointer = await repository.readCoordinationRun(key);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repository, "readCoordinationRun").mockImplementationOnce(async () => {
      await paused;
      return pointer;
    });
    const request = requestTeardown(shared, key.tenantId, "red", Date.parse(teardownAt));
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect((await repository.getDeployment("red"))?.status).toBe("DELETING");
    } finally {
      release();
    }
    expect(await request).toMatchObject({ kind: "accepted" });
  });

  it("atomically refuses both delete primitives when the current row has pending scores", async () => {
    const { repository, store, scope } = await setup(backend);
    expect(
      await writeCoordinationState(store, scope, 30, 1, at, 1, {
        occurredAt: at,
        teams: { red: { before: 0, score: 30, reason: "cipher" } },
      }),
    ).toEqual({ kind: "ok" });
    await expect(repository.deleteCoordinationState(scope)).rejects.toThrow();
    expect(await repository.deleteCoordinationStateIfUnchanged(scope, 2)).toEqual({
      outcome: "conflict",
    });
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    expect(await repository.readCoordinationMatchSecret(scope)).toBe("fixture-secret");
  });

  it("preserves a delivery committed after the delete-all preflight read", async () => {
    const { repository, store, scope, artifacts, deleteArtifacts } = await setup(backend);
    const original = repository.closeCoordinationRun.bind(repository);
    vi.spyOn(repository, "closeCoordinationRun").mockImplementationOnce(async (...args) => {
      expect(
        await writeCoordinationState(store, scope, 30, 1, at, 1, {
          occurredAt: at,
          teams: { red: { before: 0, score: 30, reason: "cipher" } },
        }),
      ).toEqual({ kind: "ok" });
      return original(...args);
    });
    await expect(deleteAllCoordinationRuns({ repository, artifacts }, key)).rejects.toThrow();
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    expect((await repository.readCoordinationRun(key))?.runId).toBe(scope.runId);
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });
});

describe("SQL coordination recovery failure isolation", () => {
  it("collects the healthy COMPLETE row before surfacing the separate recovery query failure", async () => {
    const { repository, sql } = await setup("SQL");
    const onPage = vi.fn(async (_items: readonly DeploymentRecord[]) => undefined);
    const onRecovery = vi.fn(async (_scopes: readonly CoordinationStateScope[]) => undefined);
    const failure = new Error("SQL recovery query unavailable");
    const all = sql.all.bind(sql);
    const select = vi.spyOn(sql, "all").mockImplementation((query, params) => {
      if (query.includes("FROM coordination_state_scoped")) return Promise.reject(failure);
      return all(query, params);
    });
    await expect(repository.forEachCompleteDeploymentPage(onPage, onRecovery)).rejects.toBe(
      failure,
    );
    expect(onPage).toHaveBeenCalledOnce();
    expect(onPage).toHaveBeenCalledWith([
      expect.objectContaining({ jobId: "red", status: "COMPLETE" }),
    ]);
    expect(onRecovery).not.toHaveBeenCalled();
    expect(select.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining("FROM deployments WHERE status"),
      expect.stringContaining("FROM coordination_state_scoped"),
    ]);
  });
});
