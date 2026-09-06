import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import { DEFAULT_COORDINATION_RUN_ID } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import type {
  DeploymentRecord,
  DeploymentsRepository,
} from "../../lib/problem-deploy/control-data/types.js";
import { collectTeamScoreEvents } from "../../lib/problem-deploy/handlers/event-handler/team-score-events.js";
import {
  dispatchCoordinationOp,
  projectCoordinationForTeam,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import {
  coordinationScoreDelivery,
  deliverCoordinationScores,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-scoring.js";
import {
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { handleCoordinationTickBatch } from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import { listScoreEvents } from "../../lib/problem-deploy/handlers/participant-handler/score-events.js";
import { COORDINATION_TICK_ACTION } from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract.js";
import { toPublicScoreEventView } from "../../lib/problem-deploy/handlers/shared/score-event.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";
import { fakeParticipantShared } from "./coordination.test-helpers.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = {
  tenantId: "tenant",
  eventId: "event",
  problemId: "battle",
  runId: DEFAULT_COORDINATION_RUN_ID,
};
interface State {
  scores: Record<string, number>;
  solved: boolean;
  expired: boolean;
}
interface Op {
  kind: "cipher";
}
const plugin: CoordinationPlugin<State, Op, State> = {
  initialState: (ctx) => ({
    scores: Object.fromEntries(ctx.teamIds.map((id) => [id, 0])),
    solved: false,
    expired: false,
  }),
  validateOp: (state) => (state.solved ? { ok: false, error: "already_solved" } : { ok: true }),
  applyOp: (state, teamId) => ({
    ...state,
    scores: { ...state.scores, [teamId]: state.scores[teamId] + 30 },
    solved: true,
  }),
  tick: (state, now) =>
    now < 1000 || state.expired
      ? state
      : {
          ...state,
          scores: Object.fromEntries(
            Object.entries(state.scores).map(([id, score]) => [id, Math.max(0, score - 45)]),
          ),
          expired: true,
        },
  teamScores: (state) => state.scores,
  scoreReasons: (_before, _after, cause) => ({
    red: cause.kind === "tick" ? "deadline" : "cipher",
  }),
  projectForTeam: (state) => state,
};
function deployment(teamId: string, overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    jobId: teamId,
    tenantId: scope.tenantId,
    eventId: scope.eventId,
    problemId: scope.problemId,
    teamId,
    teamName: teamId,
    teamLoginKey: `key-${teamId}`,
    namePrefix: teamId,
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    status: "COMPLETE",
    createdAt: at,
    updatedAt: at,
    score: 0,
    ...overrides,
  };
}
async function setup(backend: string, teams = ["red"]) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const repository: DeploymentsRepository =
    backend === "DynamoDB"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  const runtime = {
    ...makeTestControlDataRuntime({
      CONTROL_DATA_BACKEND: backend === "DynamoDB" ? "dynamodb" : "turso",
    }),
    resolveDeploymentsRepository: async () => repository,
  };
  const store = { runtime, ddb, tableName: "Deployments" };
  for (const team of teams) await repository.putDeployment(deployment(team));
  const input = {
    scope,
    teamId: "red",
    ctx: { eventId: scope.eventId, teamIds: teams },
    op: { kind: "cipher" as const },
    fallbackProjection: {},
    nowIso: at,
  };
  const tick = (now = 2000) =>
    handleCoordinationTickBatch(
      {
        store,
        importer: async () => ({ default: plugin }),
        config: { battle: { plugin: "battle" } },
      },
      {
        action: COORDINATION_TICK_ACTION,
        nowIso: at,
        targets: [
          {
            tenantId: scope.tenantId,
            eventId: scope.eventId,
            moduleRef: scope.problemId,
            teamIds: teams,
            eventNowMs: now,
          },
        ],
      },
    );
  return { repository, store, input, tick, sql };
}

describe.each(["DynamoDB", "SQL"])("durable coordination scoring: %s", (backend) => {
  it("records a correct operation and a floored deadline penalty through the real participant history route", async () => {
    const { repository, store, input, tick } = await setup(backend);
    expect((await dispatchCoordinationOp(store, plugin, input)).kind).toBe("ok");
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    const shared = { ...fakeParticipantShared(vi.fn()), ...store };
    expect(await listScoreEvents(shared, "key-red")).toMatchObject({
      kind: "ok",
      response: {
        entries: [{ points: 30, reason: "cipher", source: "coordination", occurredAt: at }],
      },
    });
    expect(await tick()).toMatchObject({ written: 1 });
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    const history = await repository.listScoreEvents("red", { pageSize: 100 });
    expect(history.map((event) => [event.points, event.reason])).toEqual(
      expect.arrayContaining([
        [30, "cipher"],
        [-30, "deadline"],
      ]),
    );
    expect(history.reduce((sum, event) => sum + event.points, 0)).toBe(0);
    const adminHistory = await collectTeamScoreEvents(
      { ...store, deploymentsTableName: store.tableName },
      {
        deployments: [{ jobId: "red", teamId: "red" }],
        displayNameByTeamId: new Map([["red", "Red"]]),
      },
    );
    expect(adminHistory[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "coordination", points: 30, reason: "cipher" }),
        expect.objectContaining({ source: "coordination", points: -30, reason: "deadline" }),
      ]),
    );
    await tick();
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(2);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("replaying the same submitted operation cannot add another score or history row", async () => {
    const { repository, store, input } = await setup(backend);
    await dispatchCoordinationOp(store, plugin, input);
    expect(await dispatchCoordinationOp(store, plugin, input)).toMatchObject({
      kind: "rejected",
      error: "already_solved",
    });
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
    expect((await repository.getDeployment("red"))?.score).toBe(30);
  });

  it("recovers a saved state after score delivery failed, including a tick that does not change the game", async () => {
    const { repository, store, input, tick } = await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValueOnce(new Error("transient backend failure"));
    expect((await dispatchCoordinationOp(store, plugin, input)).kind).toBe("ok");
    expect((await readCoordinationState(store, scope))?.pendingScores?.teams.red.score).toBe(30);
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(0);
    publish.mockRestore();
    await tick(0);
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
  });

  it("recovers after a partial multi-team delivery without repeating the teams already committed", async () => {
    const { repository, store, input, tick } = await setup(backend, ["red", "blue"]);
    const original = repository.publishCoordinationScore.bind(repository);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockImplementation(async (...args) => {
        if (args[2].teamId === "blue") throw new Error("second team unavailable");
        return original(...args);
      });
    const bothTeams = {
      ...plugin,
      applyOp: (state: State) => ({ ...state, scores: { red: 30, blue: 30 }, solved: true }),
    };
    expect((await dispatchCoordinationOp(store, bothTeams, input)).kind).toBe("ok");
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect((await repository.getDeployment("blue"))?.score).toBe(0);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    publish.mockRestore();
    await tick(0);
    for (const team of ["red", "blue"]) {
      expect((await repository.getDeployment(team))?.score).toBe(30);
      expect(await repository.listScoreEvents(team, { pageSize: 100 })).toHaveLength(1);
    }
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("retains pending scoring while the deployment index is missing and recovers after it catches up", async () => {
    const { repository, store, input, tick } = await setup(backend);
    const listing = vi.spyOn(repository, "listByTenantAndEvent").mockResolvedValueOnce([]);
    await dispatchCoordinationOp(store, plugin, input);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    listing.mockRestore();
    await tick(0);
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
  });

  it("refuses a score write if deployment retirement races the delivery transaction", async () => {
    const { repository, store, input, tick } = await setup(backend);
    const original = repository.publishCoordinationScore.bind(repository);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockImplementationOnce(async (...args) => {
        await repository.putDeployment(deployment("red", { status: "DELETED" }));
        return original(...args);
      });
    await dispatchCoordinationOp(store, plugin, input);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(0);
    publish.mockRestore();
    await tick(0);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("recovers an acknowledgement failure without scoring twice", async () => {
    const { repository, store, input, tick } = await setup(backend);
    const ack = vi
      .spyOn(repository, "acknowledgeCoordinationScores")
      .mockRejectedValueOnce(new Error("lost ack"));
    await dispatchCoordinationOp(store, plugin, input);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
    ack.mockRestore();
    await tick(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("does not let a pending transition be overwritten, or an old delivery overwrite a later score", async () => {
    const { repository, store, input, tick } = await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValueOnce(new Error("down"));
    await dispatchCoordinationOp(store, plugin, input);
    const pending = await readCoordinationState(store, scope);
    expect(await writeCoordinationState(store, scope, { corrupted: true }, 1, at)).toMatchObject({
      kind: "conflict",
    });
    publish.mockRestore();
    await tick();
    await deliverCoordinationScores(store, scope, pending);
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(2);
  });

  it("publishes only scoped deployments and retains the batch instead of silently losing an unknown team", async () => {
    const { repository, store, input } = await setup(backend);
    await repository.putDeployment(
      deployment("red", { jobId: "foreign", tenantId: "other-tenant" }),
    );
    await repository.putDeployment(
      deployment("red", { jobId: "other-problem", problemId: "other-battle" }),
    );
    await dispatchCoordinationOp(store, plugin, input);
    expect((await repository.getDeployment("foreign"))?.score).toBe(0);
    expect((await repository.getDeployment("other-problem"))?.score).toBe(0);
    expect(await repository.listScoreEvents("foreign", { pageSize: 100 })).toHaveLength(0);
  });

  it("serializes concurrent operations and keeps exactly one accepted score change", async () => {
    const { repository, store, input } = await setup(backend);
    const outcomes = await Promise.all([
      dispatchCoordinationOp(store, plugin, input, { backoff: () => Promise.resolve() }),
      dispatchCoordinationOp(store, plugin, input, { backoff: () => Promise.resolve() }),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === "ok")).toHaveLength(1);
    await deliverCoordinationScores(store, scope, await readCoordinationState(store, scope));
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
  });

  it("handles more than 49 teams in a tick without a transaction-size roster limit", async () => {
    const teams = Array.from({ length: 60 }, (_, index) => `team-${index}`);
    const { repository, store, tick } = await setup(backend, teams);
    for (const team of teams) await repository.putDeployment(deployment(team, { score: 30 }));
    await writeCoordinationState(
      store,
      scope,
      { scores: Object.fromEntries(teams.map((team) => [team, 30])), solved: true, expired: false },
      0,
      at,
    );
    expect(await tick()).toMatchObject({ written: 1 });
    for (const team of teams) {
      expect((await repository.getDeployment(team))?.score).toBe(0);
      expect(await repository.listScoreEvents(team, { pageSize: 100 })).toMatchObject([
        { points: -30 },
      ]);
    }
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("does not partially write history when the score CAS fails", async () => {
    const { repository, store, input } = await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValueOnce(new Error("down"));
    await dispatchCoordinationOp(store, plugin, input);
    publish.mockRestore();
    const result = await repository.publishCoordinationScore(scope, 1, {
      jobId: "red",
      teamId: "red",
      expectedScore: 99,
      expectedStatus: "COMPLETE",
      score: 30,
      events: [
        {
          jobId: "red",
          problemId: "battle",
          teamId: "red",
          eventId: "event",
          source: "coordination",
          result: "ok",
          occurredAt: at,
          points: 30,
          reason: "cipher",
          expiresAt: 0,
        },
      ],
    });
    expect(result.outcome).toBe("conflict");
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(0);
    await deliverCoordinationScores(store, scope, await readCoordinationState(store, scope));
    expect((await repository.getDeployment("red"))?.score).toBe(30);
  });

  it("retries pending scoring on a read even after scheduled event ticks stop", async () => {
    const { repository, store, input } = await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValueOnce(new Error("down"));
    await dispatchCoordinationOp(store, plugin, input);
    const prior = await readCoordinationState(store, scope);
    publish.mockRestore();
    await projectCoordinationForTeam(store, plugin, input);
    const repaired = await readCoordinationState(store, scope);
    expect(repaired?.state).toEqual(prior?.state);
    expect(repaired?.expiresAt).toBe(prior?.expiresAt);
    expect(repaired?.version).toBe(prior?.version);
    expect(repaired?.pendingScores).toBeUndefined();
    expect((await repository.getDeployment("red"))?.score).toBe(30);
  });

  it("does not block the remaining teams when a scored team's deployment is retired", async () => {
    const { repository, store, tick } = await setup(backend, ["red", "blue"]);
    await repository.putDeployment(deployment("red", { score: 30, status: "DELETED" }));
    await repository.putDeployment(deployment("blue", { score: 30 }));
    await writeCoordinationState(
      store,
      scope,
      { scores: { red: 30, blue: 30 }, solved: true, expired: false },
      0,
      at,
    );
    await tick();
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect((await repository.getDeployment("blue"))?.score).toBe(0);
    expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
  });

  it("rejects delayed delivery from a retired run", async () => {
    const { repository, store, input } = await setup(backend);
    const publish = vi
      .spyOn(repository, "publishCoordinationScore")
      .mockRejectedValueOnce(new Error("down"));
    await dispatchCoordinationOp(store, plugin, input);
    publish.mockRestore();
    await repository.rotateCoordinationRun(
      scope,
      scope.runId,
      { runId: "next-run", startedAt: at, history: [] },
      0,
    );
    await expect(
      deliverCoordinationScores(store, scope, await readCoordinationState(store, scope)),
    ).rejects.toThrow("conflicted");
    expect((await repository.getDeployment("red"))?.score).toBe(0);
    expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(0);
  });

  it("explains a legacy cumulative-score repair separately from the operation", async () => {
    const { repository, store, input } = await setup(backend);
    await repository.putDeployment(deployment("red", { score: 20 }));
    await dispatchCoordinationOp(store, plugin, input);
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    const events = await repository.listScoreEvents("red", { pageSize: 100 });
    expect(events.map((event) => [event.points, event.reason])).toEqual(
      expect.arrayContaining([
        [-20, "sync"],
        [30, "cipher"],
      ]),
    );
  });
});

it("drops arbitrary plugin reason strings and all private metadata before publication", () => {
  const before: State = { scores: { red: 0 }, solved: false, expired: false };
  const after = { ...before, scores: { red: 30 } };
  const delivery = coordinationScoreDelivery(
    { ...plugin, scoreReasons: () => ({ red: "secret=123" }) },
    before,
    after,
    { kind: "op", teamId: "red", op: { kind: "cipher" } },
    at,
  );
  expect(delivery?.teams.red.reason).toBe("coordination");
  const publicEvent = toPublicScoreEventView({
    jobId: "red",
    problemId: "battle",
    source: "coordination",
    result: "ok",
    points: 30,
    occurredAt: at,
    reason: "secret=123",
    teamId: "private-team",
    expiresAt: 12,
  });
  expect(publicEvent).toEqual({
    jobId: "red",
    problemId: "battle",
    source: "coordination",
    result: "ok",
    points: 30,
    occurredAt: at,
    reason: "coordination",
  });
});

it("rolls back the SQL score and version when a history INSERT fails, then retries the saved delivery", async () => {
  const { repository, store, input, tick, sql } = await setup("SQL");
  const original = sql.batch.bind(sql);
  const batch = vi.spyOn(sql, "batch").mockImplementationOnce((statements) =>
    original([
      ...statements,
      {
        sql: "INSERT INTO deployment_score_events (job_id, sk, record_type, payload) VALUES ('failure', '', NULL, '{}')",
      },
    ]),
  );
  await dispatchCoordinationOp(store, plugin, input);
  expect((await repository.getDeployment("red"))?.score).toBe(0);
  expect((await repository.getDeployment("red"))?.coordinationScoreVersion).toBeUndefined();
  expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(0);
  expect((await readCoordinationState(store, scope))?.pendingScores).toBeDefined();
  batch.mockRestore();
  await tick(0);
  expect((await repository.getDeployment("red"))?.score).toBe(30);
  expect(await repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
});
