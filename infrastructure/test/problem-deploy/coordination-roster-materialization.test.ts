import type { CoordinationContext, CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import {
  DynamoDbEventsRepository,
  SqlEventsRepository,
} from "../../lib/problem-deploy/control-data/events-repository.js";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/types.js";
import {
  type CoordinationScopeResolution,
  handleCoordinationOp,
  makeCoordinationScopeResolver,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import { readCoordinationState } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { handleCoordinationTickBatch } from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { COORDINATION_TICK_ACTION } from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";
import { fakeArtifactStore } from "./coordination.test-helpers.js";

const at = "2026-09-06T00:01:00.000Z";
const key = { tenantId: "tenant", eventId: "event", problemId: "battle" };
const scope = { ...key, runId: "default" };
const config = { battle: { plugin: "battle.ts" } };
const expectedTeams = ["alpha", "bravo"];
const expectedNames = { alpha: "Alpha", bravo: "Bravo" };
const op = { kind: "greet" as const, targetTeamId: "bravo" };
interface State {
  teamIds: readonly string[];
  teamNames: Readonly<Record<string, string>>;
  moves: number;
  ticks: number;
}

function deployment(teamId: string, overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    ...key,
    jobId: teamId,
    teamId,
    teamName: teamId,
    displayTeamName: teamId === "alpha" ? "Alpha" : "Bravo",
    teamLoginKey: `login-${teamId}`,
    namePrefix: teamId,
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    status: "COMPLETE",
    createdAt: at,
    updatedAt: at,
    eventStartsAt: "2026-09-06T00:00:00.000Z",
    eventEndsAt: "2026-09-06T01:00:00.000Z",
    ...overrides,
  };
}

async function setup(backend: string) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const repository =
    backend === "DynamoDB"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  const events =
    backend === "DynamoDB"
      ? new DynamoDbEventsRepository(ddb, "Events")
      : new SqlEventsRepository(sql);
  await events.putEvent({
    tenantId: key.tenantId,
    eventId: key.eventId,
    name: "Roster fixture",
    status: "RUNNING",
    teamCount: 2,
    createdAt: at,
    updatedAt: at,
    expiresAt: 0,
    problems: [],
    startsAt: "2026-09-06T00:00:00.000Z",
    endsAt: "2026-09-06T01:00:00.000Z",
  });
  for (const row of [
    deployment("bravo"),
    deployment("alpha"),
    deployment("other-tenant", { tenantId: "other-tenant" }),
    deployment("other-event", { eventId: "other-event" }),
    deployment("other-problem", { problemId: "other-battle" }),
  ])
    await repository.putDeployment(row);
  const runtime = {
    ...makeTestControlDataRuntime({
      CONTROL_DATA_BACKEND: backend === "DynamoDB" ? "dynamodb" : "turso",
    }),
    resolveDeploymentsRepository: async () => repository,
    resolveEventsRepository: async () => events,
  };
  const store: ParticipantSharedResources = {
    runtime,
    ddb,
    tableName: "Deployments",
    eventsTableName: "Events",
    endpointsTableName: "",
    problemsScoring: {},
    problemsEndpoints: {},
  };
  const initialState = vi.fn(
    (ctx: CoordinationContext): State => ({
      teamIds: ctx.teamIds,
      teamNames: ctx.teamNames ?? {},
      moves: 0,
      ticks: 0,
    }),
  );
  const tick = vi.fn((state: State): State => ({ ...state, ticks: state.ticks + 1 }));
  const plugin: CoordinationPlugin<State, typeof op, State> = {
    initialState,
    validateOp: (state, _teamId, action) =>
      state.teamIds.includes(action.targetTeamId)
        ? { ok: true }
        : { ok: false, error: "unknown_team" },
    applyOp: (state) => ({ ...state, moves: state.moves + 1 }),
    projectForTeam: (state) => state,
    tick,
  };
  const resolve = makeCoordinationScopeResolver(store, config);
  const resolutions: CoordinationScopeResolution[] = [];
  const deps = {
    store,
    config,
    importer: async () => ({ default: plugin }),
    artifacts: fakeArtifactStore(),
    resolveScope: async (login: string, problemId?: string) => {
      const resolution = await resolve(login, problemId);
      resolutions.push(resolution);
      return resolution;
    },
  };
  const write = vi.spyOn(repository, "writeCoordinationState");
  const mint = vi.spyOn(repository, "ensureCoordinationMatchSecret");
  const roster = vi.spyOn(repository, "listByTenantAndEvent");
  const apply = () => handleCoordinationOp(deps, "login-alpha", op, at, key.problemId);
  const runTick = () =>
    handleCoordinationTickBatch(deps, {
      action: COORDINATION_TICK_ACTION,
      nowIso: at,
      targets: [
        {
          tenantId: key.tenantId,
          eventId: key.eventId,
          moduleRef: key.problemId,
          eventNowMs: 60_000,
          teamIds: ["alpha"],
        },
      ],
    });
  return {
    repository,
    store,
    initialState,
    tick,
    resolutions,
    write,
    mint,
    roster,
    apply,
    runTick,
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["DynamoDB", "SQL"])("roster failure before materialization: %s", (backend) => {
  it("refuses the first operation without creating a secret or state, then retries with both teams", async () => {
    const ctx = await setup(backend);
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));

    expect(await ctx.apply()).toEqual({ kind: "unavailable" });
    expect(ctx.resolutions[0]).toMatchObject({ kind: "scope", scope: { rosterIncomplete: true } });
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(await ctx.repository.readCoordinationMatchSecret(scope)).toBeUndefined();
    expect(await readCoordinationState(ctx.store, scope)).toBeUndefined();

    expect(await ctx.apply()).toEqual({
      kind: "ok",
      projection: {
        teamIds: expectedTeams,
        teamNames: expectedNames,
        moves: 1,
        ticks: 0,
      },
    });
    expect(ctx.resolutions[1]).not.toMatchObject({ scope: { rosterIncomplete: true } });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.initialState).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: key.eventId,
        teamIds: expectedTeams,
        teamNames: expectedNames,
        matchSecret: expect.any(String),
      }),
    );
    expect(ctx.mint).toHaveBeenCalledTimes(1);
    expect(ctx.write).toHaveBeenCalledTimes(1);
    expect(await readCoordinationState(ctx.store, scope)).toMatchObject({
      version: 1,
      state: { teamIds: expectedTeams, teamNames: expectedNames, moves: 1 },
    });
  });

  it("continues operations against existing full-roster state during a roster-query failure", async () => {
    const ctx = await setup(backend);
    expect((await ctx.apply()).kind).toBe("ok");
    const secret = await ctx.repository.readCoordinationMatchSecret(scope);
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));

    expect(await ctx.apply()).toEqual({
      kind: "ok",
      projection: {
        teamIds: expectedTeams,
        teamNames: expectedNames,
        moves: 2,
        ticks: 0,
      },
    });
    expect(ctx.resolutions[1]).toMatchObject({ kind: "scope", scope: { rosterIncomplete: true } });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.mint).toHaveBeenCalledTimes(1);
    expect(ctx.write).toHaveBeenCalledTimes(2);
    expect(await ctx.repository.readCoordinationMatchSecret(scope)).toBe(secret);
    expect(await readCoordinationState(ctx.store, scope)).toMatchObject({
      version: 2,
      state: { teamIds: expectedTeams, teamNames: expectedNames, moves: 2 },
    });
  });

  it("defers the first active tick until its full roster can be read", async () => {
    const ctx = await setup(backend);
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));

    expect(await ctx.runTick()).toEqual({ ticked: 1, written: 0 });
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(ctx.tick).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(await ctx.repository.readCoordinationMatchSecret(scope)).toBeUndefined();
    expect(await readCoordinationState(ctx.store, scope)).toBeUndefined();

    expect(await ctx.runTick()).toEqual({ ticked: 1, written: 1 });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.initialState).toHaveBeenCalledWith(
      expect.objectContaining({
        teamIds: expectedTeams,
        teamNames: expectedNames,
      }),
    );
    expect(ctx.tick).toHaveBeenCalledTimes(1);
    expect(ctx.mint).toHaveBeenCalledTimes(1);
    expect(await readCoordinationState(ctx.store, scope)).toMatchObject({
      version: 1,
      state: { teamIds: expectedTeams, teamNames: expectedNames, moves: 0, ticks: 1 },
    });
  });
});
