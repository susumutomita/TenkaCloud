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
  createCompositeParent,
  createCompositeTarget,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository.js";
import {
  type CoordinationScopeResolution,
  handleCoordinationArtifactFetch,
  handleCoordinationOp,
  handleCoordinationProjection,
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

async function setup(backend: string, tickOnRequest = false) {
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
    tickOnRequest,
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
    resolveScope: async (...args: Parameters<typeof resolve>) => {
      const resolution = await resolve(...args);
      resolutions.push(resolution);
      return resolution;
    },
  };
  const write = vi.spyOn(repository, "writeCoordinationState");
  const mint = vi.spyOn(repository, "ensureCoordinationMatchSecret");
  const roster = vi.spyOn(repository, "listByTenantAndEvent");
  const apply = () => handleCoordinationOp(deps, "login-alpha", op, at, key.problemId);
  const project = () => handleCoordinationProjection(deps, "login-alpha", key.problemId);
  const fetchArtifact = () =>
    handleCoordinationArtifactFetch(deps, "login-alpha", "proof", key.problemId);
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
  const peer = () => {
    const peerRepository =
      backend === "DynamoDB"
        ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
        : new SqlDeploymentsRepository(sql);
    const peerStore = {
      ...store,
      runtime: { ...runtime, resolveDeploymentsRepository: async () => peerRepository },
    };
    return {
      repository: peerRepository,
      deps: {
        ...deps,
        store: peerStore,
        resolveScope: makeCoordinationScopeResolver(peerStore, config),
      },
    };
  };
  return {
    repository,
    deps,
    store,
    initialState,
    tick,
    resolutions,
    write,
    mint,
    roster,
    apply,
    project,
    fetchArtifact,
    runTick,
    peer,
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["DynamoDB", "SQL"])("roster failure before materialization: %s", (backend) => {
  it("shares one 99-team initialization across independent operation and tick hosts", async () => {
    const ctx = await setup(backend);
    for (let i = 0; i < 97; i += 1) await ctx.repository.putDeployment(deployment(`team-${i}`));
    const peer = ctx.peer();
    const peerReads = vi.spyOn(peer.repository, "getDeployment");
    const getMeta = ctx.repository.getDeployment.bind(ctx.repository);
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const reads = vi.spyOn(ctx.repository, "getDeployment").mockImplementation(async (...args) => {
      entered.resolve(undefined);
      await gate.promise;
      return getMeta(...args);
    });
    const winner = ctx.apply();
    await entered.promise;
    const others = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleCoordinationOp(peer.deps, "login-bravo", op, at, key.problemId),
      ),
    );
    expect(others).toEqual(Array.from({ length: 10 }, () => ({ kind: "conflict" })));
    expect(
      await handleCoordinationTickBatch(peer.deps, {
        action: COORDINATION_TICK_ACTION,
        nowIso: at,
        targets: [{ ...key, moduleRef: key.problemId, eventNowMs: 60_000, teamIds: expectedTeams }],
      }),
    ).toEqual({ ticked: 1, written: 0 });
    expect(peerReads).not.toHaveBeenCalled();
    expect(ctx.initialState).not.toHaveBeenCalled();
    gate.resolve(undefined);
    expect((await winner).kind).toBe("ok");
    expect(reads).toHaveBeenCalledTimes(99);
    // A losing client retries against committed state without rediscovering the roster.
    expect((await handleCoordinationOp(peer.deps, "login-bravo", op, at, key.problemId)).kind).toBe(
      "ok",
    );
    expect(peerReads).not.toHaveBeenCalled();
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect((await readCoordinationState(ctx.store, scope))?.state).toMatchObject({ moves: 2 });
  });

  it("releases initialization after rejected operations and failed plugin loads", async () => {
    const ctx = await setup(backend);
    expect(
      await handleCoordinationOp(
        ctx.deps,
        "login-alpha",
        { ...op, targetTeamId: "absent" },
        at,
        key.problemId,
      ),
    ).toEqual({ kind: "rejected", error: "unknown_team" });
    expect(await ctx.repository.readCoordinationState(scope)).toBeUndefined();
    const peer = ctx.peer();
    expect(
      await handleCoordinationOp(
        {
          ...peer.deps,
          importer: async () => {
            throw new Error("fixture unavailable");
          },
        },
        "login-alpha",
        op,
        at,
        key.problemId,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(await ctx.repository.readCoordinationState(scope)).toBeUndefined();
    expect((await ctx.apply()).kind).toBe("ok");
  });

  it("refuses a request snapshot from any different scope", async () => {
    const ctx = await setup(backend);
    await ctx.apply();
    const row = await readCoordinationState(ctx.store, scope);
    for (const dimension of ["tenantId", "eventId", "problemId", "runId"] as const) {
      await expect(
        readCoordinationState(ctx.store, scope, {
          scope: { ...scope, [dimension]: "different" },
          row,
        }),
      ).rejects.toThrow("Coordination snapshot scope mismatch");
    }
  });

  it.each([
    "2026-09-05T23:59:00.000Z",
    "2026-09-06T01:00:00.000Z",
  ])("rejects inactive operations before any roster reads at %s", async (nowIso) => {
    const ctx = await setup(backend);
    for (let i = 0; i < 97; i += 1) await ctx.repository.putDeployment(deployment(`team-${i}`));
    const metaReads = vi.spyOn(ctx.repository, "getDeployment");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleCoordinationOp(ctx.deps, "login-alpha", op, nowIso, key.problemId),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 10 }, () => ({ kind: "rejected", error: "event_ended" })),
    );
    expect(ctx.roster).not.toHaveBeenCalled();
    expect(metaReads).not.toHaveBeenCalled();
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    // The refusal must not persist a minimal roster: an active operation still gets all teams.
    expect((await ctx.apply()).kind).toBe("ok");
    expect(metaReads).toHaveBeenCalledTimes(99);
    expect(ctx.initialState.mock.lastCall?.[0].teamIds).toHaveLength(99);
  });

  it("serves absent-run projections and artifacts despite malformed superseded history", async () => {
    const ctx = await setup(backend);
    await ctx.repository.putDeployment(
      deployment("alpha", {
        jobId: "alpha-old",
        teamLoginKey: "login-old-alpha",
        createdAt: "2026-09-01T00:00:00.000Z",
        stackOutputs: "{broken",
      }),
    );
    await ctx.repository.putDeployment(
      deployment("alpha", {
        stackOutputs: JSON.stringify({ CoordinationSetting: "current" }),
      }),
    );
    const metaReads = vi.spyOn(ctx.repository, "getDeployment");
    expect((await ctx.project()).kind).toBe("ok");
    expect((await ctx.fetchArtifact()).kind).not.toBe("unavailable");
    expect(ctx.initialState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        teamIds: expectedTeams,
        deploymentInputs: { alpha: { CoordinationSetting: "current" } },
      }),
    );
    expect(metaReads).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
  });

  it("keeps actual composite parent/target records outside the event roster and login path", async () => {
    const ctx = await setup(backend);
    await createCompositeParent(ctx.store, {
      parentDeploymentId: "composite-parent",
      tenantId: key.tenantId,
      problemId: key.problemId,
      targetCount: 2,
      teamName: "Composite",
      teamLoginKey: "login-composite",
      createdAt: at,
      expiresAt: 0,
      status: "COMPLETE",
    });
    for (let ordinal = 0; ordinal < 2; ordinal += 1) {
      await createCompositeTarget(ctx.store, {
        targetDeploymentId: `composite-target-${ordinal}`,
        parentDeploymentId: "composite-parent",
        targetId: `target-${ordinal}`,
        targetOrdinal: ordinal,
        tenantId: key.tenantId,
        problemId: key.problemId,
        provider: "aws",
        engine: "cloudformation",
        entry: "template.yaml",
        awsAccountId: "123456789012",
        region: "ap-northeast-1",
        teamName: "Composite",
        teamLoginKey: "login-composite",
        namePrefix: `composite-${ordinal}`,
        createdAt: at,
        expiresAt: 0,
        status: "COMPLETE",
      });
    }
    expect(await ctx.repository.listCompositeTargets("composite-parent")).toHaveLength(2);
    const discovered = await ctx.repository.listByTenantAndEvent(key.tenantId, key.eventId);
    expect(discovered.some((record) => record.jobId.startsWith("composite-"))).toBe(false);
    expect(await ctx.deps.resolveScope("login-composite", key.problemId)).toEqual({
      kind: "not_configured",
    });
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect((await ctx.apply()).kind).toBe("ok");
    expect(ctx.initialState).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ teamIds: expectedTeams }),
    );
  });

  it("does not persist a run from malformed authoritative outputs, and recovers after repair", async () => {
    const ctx = await setup(backend);
    await ctx.repository.putDeployment(deployment("alpha", { stackOutputs: "{broken" }));
    expect(await ctx.apply()).toEqual({ kind: "unavailable" });
    expect(await ctx.runTick()).toEqual({ ticked: 1, written: 0 });
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    await ctx.repository.putDeployment(
      deployment("alpha", {
        stackOutputs: JSON.stringify({ CoordinationSetting: "on" }),
      }),
    );
    expect((await ctx.apply()).kind).toBe("ok");
    expect(ctx.initialState).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deploymentInputs: { alpha: { CoordinationSetting: "on" } } }),
    );
  });

  it("uses index-only previews for 99 teams without persisting stale inputs on the first operation", async () => {
    const ctx = await setup(backend);
    ctx.tick.mockImplementation((state) => state);
    const teamIds = ["alpha", "bravo", ...Array.from({ length: 97 }, (_, i) => `team-${i}`)].sort();
    for (const id of teamIds.filter((id) => !expectedTeams.includes(id))) {
      await ctx.repository.putDeployment(deployment(id));
    }
    const indexedRows = await ctx.repository.listByTenantAndEvent(key.tenantId, key.eventId);
    ctx.roster.mockResolvedValue(indexedRows);
    await ctx.repository.putDeployment(
      deployment("alpha", {
        stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "current-fixture" }),
      }),
    );
    // This supported plugin has no teamScores and a no-op tick: state remains absent.
    expect(await ctx.runTick()).toEqual({ ticked: 1, written: 0 });
    ctx.initialState.mockClear();
    ctx.mint.mockClear();
    const metaReads = vi.spyOn(ctx.repository, "getDeployment");
    for (let round = 0; round < 2; round += 1) {
      const results = await Promise.all(
        teamIds.map((id) =>
          handleCoordinationProjection(ctx.deps, `login-${id}`, key.problemId, at),
        ),
      );
      expect(results.every((result) => result.kind === "ok")).toBe(true);
    }
    await ctx.fetchArtifact();
    expect(metaReads).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    expect(await ctx.repository.readCoordinationState(scope)).toBeUndefined();
    expect(ctx.initialState).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamIds, teamNames: expect.any(Object) }),
    );
    expect(ctx.initialState.mock.lastCall?.[0].deploymentInputs).toBeUndefined();

    ctx.initialState.mockClear();
    expect((await ctx.apply()).kind).toBe("ok");
    expect(metaReads).toHaveBeenCalledTimes(99);
    expect(ctx.initialState).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        teamIds,
        deploymentInputs: { alpha: { CoordinationPrivateMaterial: "current-fixture" } },
      }),
    );
    expect(ctx.write).toHaveBeenCalledTimes(1);
  });

  it("does not reread deployment rosters when 99 teams poll an initialized run", async () => {
    const ctx = await setup(backend);
    const teamIds = ["alpha", "bravo", ...Array.from({ length: 97 }, (_, i) => `team-${i}`)];
    for (const id of teamIds.slice(2)) await ctx.repository.putDeployment(deployment(id));
    expect((await ctx.apply()).kind).toBe("ok");
    ctx.roster.mockClear();
    const metaReads = vi.spyOn(ctx.repository, "getDeployment");
    const stateReads = vi.spyOn(ctx.repository, "readCoordinationState");
    const results = await Promise.all(
      teamIds.map((id) => handleCoordinationProjection(ctx.deps, `login-${id}`, key.problemId)),
    );
    expect(stateReads).toHaveBeenCalledTimes(99);
    await ctx.fetchArtifact();
    expect(stateReads).toHaveBeenCalledTimes(100);
    expect(results.every((result) => result.kind === "ok")).toBe(true);
    expect(ctx.roster).not.toHaveBeenCalled();
    expect(metaReads).not.toHaveBeenCalled();
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
  });

  it("does not recreate deleted state after a snapshot-based operation loses its write race", async () => {
    const ctx = await setup(backend);
    await ctx.apply();
    const resolve = ctx.deps.resolveScope;
    ctx.deps.resolveScope = async (...args) => {
      const result = await resolve(...args);
      await ctx.repository.deleteCoordinationState(scope);
      return result;
    };
    ctx.roster.mockClear();
    expect(await ctx.apply()).toEqual({ kind: "unavailable" });
    expect(ctx.roster).not.toHaveBeenCalled();
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(await ctx.repository.readCoordinationState(scope)).toBeUndefined();
  });

  it("uses the snapshot for request ticks and reloads before projecting the updated state", async () => {
    const ctx = await setup(backend, true);
    await ctx.apply();
    const reads = vi.spyOn(ctx.repository, "readCoordinationState");
    expect(
      (await handleCoordinationProjection(ctx.deps, "login-alpha", key.problemId, at)).kind,
    ).toBe("ok");
    expect(reads).toHaveBeenCalledTimes(2);
    const state = await readCoordinationState(ctx.store, scope);
    expect(state?.state).toMatchObject({ ticks: 2 });
  });

  it("reloads state on conflicting operations instead of replaying their initial snapshots", async () => {
    const ctx = await setup(backend);
    await ctx.apply();
    expect((await Promise.all([ctx.apply(), ctx.apply()])).map((result) => result.kind)).toEqual([
      "ok",
      "ok",
    ]);
    expect((await readCoordinationState(ctx.store, scope))?.state).toMatchObject({ moves: 3 });
  });

  it("refuses an absent-state projection during roster failure, then shows the complete board", async () => {
    const ctx = await setup(backend);
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));
    expect(await ctx.project()).toEqual({ kind: "unavailable" });
    expect(ctx.initialState).not.toHaveBeenCalled();
    expect(ctx.mint).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(await ctx.project()).toEqual({
      kind: "ok",
      projection: { teamIds: expectedTeams, teamNames: expectedNames, moves: 0, ticks: 0 },
    });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.mint).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
  });

  it("does not authorize artifacts against a made-up partial board", async () => {
    const ctx = await setup(backend);
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));
    expect(await ctx.fetchArtifact()).toEqual({ kind: "unavailable" });
    expect(ctx.initialState).not.toHaveBeenCalled();
  });

  it("continues projecting stored full-roster state while the roster lookup is unavailable", async () => {
    const ctx = await setup(backend);
    await ctx.apply();
    ctx.roster.mockRejectedValueOnce(new Error("roster index unavailable"));
    expect(await ctx.project()).toEqual({
      kind: "ok",
      projection: { teamIds: expectedTeams, teamNames: expectedNames, moves: 1, ticks: 0 },
    });
    expect(ctx.initialState).toHaveBeenCalledTimes(1);
    expect(ctx.write).toHaveBeenCalledTimes(1);
  });

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
