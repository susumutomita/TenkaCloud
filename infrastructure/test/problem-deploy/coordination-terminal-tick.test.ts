import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import battle from "../../../problems/battles/crypto-battle/coordination/crypto-battle.ts";
import type { CryptoBattleState } from "../../../problems/battles/crypto-battle/game/src/types.ts";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import {
  DynamoDbEventsRepository,
  SqlEventsRepository,
} from "../../lib/problem-deploy/control-data/events-repository.js";
import { SqlFeatureFlagsRepository } from "../../lib/problem-deploy/control-data/sql-feature-flags-repository.js";
import { SqlNotificationsRepository } from "../../lib/problem-deploy/control-data/sql-notifications-repository.js";
import { SqlTeamsRepository } from "../../lib/problem-deploy/control-data/sql-teams-repository.js";
import type { DeploymentRecord, EventRecord } from "../../lib/problem-deploy/control-data/types.js";
import { endEvent } from "../../lib/problem-deploy/handlers/event-handler/end-event.js";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared.js";
import { createCoordinationTickPass } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";
import { dispatchCoordinationOp } from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import {
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import {
  handleCoordinationTickBatch,
  parseCoordinationTickBatch,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import type { CoordinationTickBatch } from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract.js";
import { coordinationRoundWindow } from "../../lib/problem-deploy/handlers/shared/saved-catalog-context.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

const startsAt = "2026-09-06T00:00:20.000Z";
const endsAt = "2026-09-06T00:10:20.000Z";
const key = { tenantId: "tenant", eventId: "event", problemId: "battle" };
const scope = { ...key, runId: "default" };
const deployment: DeploymentRecord = {
  ...key,
  jobId: "red",
  teamId: "red",
  teamName: "Red",
  teamLoginKey: "login",
  namePrefix: "red",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  status: "COMPLETE",
  createdAt: startsAt,
  updatedAt: startsAt,
  eventStartsAt: startsAt,
  eventEndsAt: endsAt,
  score: 0,
};
const event: EventRecord = {
  tenantId: key.tenantId,
  eventId: key.eventId,
  name: "Battle",
  status: "READY",
  startsAt,
  endsAt,
  problems: [{ problemId: "battle" }],
  teamCount: 2,
  createdAt: startsAt,
  updatedAt: startsAt,
  expiresAt: 2_000_000_000,
};

async function setup(
  backend: string,
  plugin: CoordinationPlugin<unknown, unknown>,
  teams = ["red"],
) {
  const sql = makeSqliteExecutor();
  const ddb = makeFakeDdb();
  const repository =
    backend === "SQL"
      ? new SqlDeploymentsRepository(sql)
      : new DynamoDbDeploymentsRepository(ddb, "Deployments");
  const events =
    backend === "SQL"
      ? new SqlEventsRepository(sql)
      : new DynamoDbEventsRepository(ddb, "Events", "Teams");
  const runtime = {
    ...makeTestControlDataRuntime({
      CONTROL_DATA_BACKEND: backend === "SQL" ? "turso" : "dynamodb",
    }),
    resolveDeploymentsRepository: async () => repository,
    resolveEventsRepository: async () => events,
    resolveTeamsRepository: async () => new SqlTeamsRepository(sql),
    resolveRepositories: async () => ({
      events,
      teams: new SqlTeamsRepository(sql),
      notifications: new SqlNotificationsRepository(sql),
      featureFlags: new SqlFeatureFlagsRepository(sql),
    }),
  };
  const store = {
    runtime,
    ddb,
    tableName: "Deployments",
    coordinationScoreModes: { battle: "exclusive" as const },
  };
  await events.putEvent(event);
  for (const team of teams)
    await repository.putDeployment({ ...deployment, jobId: team, teamId: team });
  const importer = vi.fn(async () => ({ default: plugin }));
  const scoped = { store, importer, config: { battle: { plugin: "battle" } } };
  const deps = {
    ...scoped,
    resolveCatalog: async () => ({
      ...scoped,
      event: await events.getEvent(key.tenantId, key.eventId, true),
    }),
  };
  const batches: CoordinationTickBatch[] = [];
  let drop = false;
  const invoke = vi.fn(async (_name: string, batch: CoordinationTickBatch) => {
    batches.push(batch);
    if (drop) return;
    const parsed = parseCoordinationTickBatch(JSON.parse(JSON.stringify(batch)));
    if (parsed) await handleCoordinationTickBatch(deps, parsed);
  });
  const passAt = async (at: string) => {
    const pass = createCoordinationTickPass(
      invoke,
      "dispatcher",
      new Set(["battle"]),
      repository,
      async () => ({
        problemIds: new Set(["battle"]),
        window: coordinationRoundWindow(await events.getEvent(key.tenantId, key.eventId, true), {}),
      }),
    );
    await repository.forEachCompleteDeploymentPage(
      (rows) => pass.collect(rows, at),
      (scopes) => pass.collectRecovery(scopes),
    );
    await pass.run(Date.parse(at), at);
  };
  const endAt = async (at: string) =>
    endEvent(
      {
        ...store,
        deploymentsTableName: "Deployments",
        eventsTableName: "Events",
        teamsTableName: "Teams",
      } as unknown as EventSharedResources,
      key.tenantId,
      key.eventId,
      Date.parse(at),
    );
  return {
    repository,
    events,
    store,
    sql,
    ddb,
    deps,
    importer,
    batches,
    invoke,
    passAt,
    endAt,
    setDrop: (value: boolean) => {
      drop = value;
    },
  };
}

const seen: number[] = [];
const clockPlugin: CoordinationPlugin<{ phase: string; at?: number }, unknown> = {
  initialState: () => ({ phase: "running" }),
  tick: (_state, at, timing) => {
    seen.push(at);
    return { phase: timing?.matchDurationMs === at ? "ended" : "running", at };
  },
  validateOp: () => ({ ok: true }),
  applyOp: (s) => s,
  projectForTeam: (s) => s,
};

describe.each(["SQL", "DynamoDB"])("terminal tick: %s", (backend) => {
  it("delivers the missing endpoint after minute passes skip over a ten-minute match", async () => {
    seen.length = 0;
    const ctx = await setup(backend, clockPlugin);
    for (let minute = 1; minute <= 13; minute++) {
      await ctx.passAt(
        new Date(Date.parse("2026-09-06T00:00:00.000Z") + minute * 60_000).toISOString(),
      );
    }
    expect((await readCoordinationState(ctx.store, scope))?.state).toEqual({
      phase: "ended",
      at: 600_000,
    });
    expect(seen).toEqual([
      40_000, 100_000, 160_000, 220_000, 280_000, 340_000, 400_000, 460_000, 520_000, 580_000,
      600_000,
    ]);
    expect(ctx.invoke).toHaveBeenCalledTimes(11);
  });

  it.each([false, true])(
    "persists real crypto settlement and retries delivery once (End Event=%s)",
    async (early) => {
      const ctx = await setup(backend, battle, ["red", "blue"]);
      let initial = battle.initialState({
        eventId: key.eventId,
        teamIds: ["red", "blue"],
        matchSecret: "test-only-match-seed",
        matchDurationMs: 600_000,
      });
      initial = battle.applyOp(initial, "red", { kind: "ready" });
      initial = battle.applyOp(initial, "blue", { kind: "ready" });
      initial = {
        ...initial,
        teams: Object.fromEntries(
          Object.entries(initial.teams).map(([id, team]) => [id, { ...team, score: 5000 }]),
        ),
      };
      await writeCoordinationState(
        ctx.store,
        scope,
        initial,
        0,
        startsAt,
        battle.stateSchemaVersion,
      );
      for (const id of ["red", "blue"])
        await ctx.repository.putDeployment({
          ...deployment,
          jobId: id,
          teamId: id,
          score: 5000,
          coordinationSubtotal: 5000,
        });
      await ctx.passAt("2026-09-06T00:10:00.000Z");
      const before = (await readCoordinationState(ctx.store, scope))?.state as CryptoBattleState;
      expect(before.phase).toBe("endgame");
      const open = before.contracts.filter((order) => order.status === "open");
      expect(open.length).toBeGreaterThan(0);
      expect(before.endgameLightning?.status).toBe("awarded");
      if (early) expect(await ctx.endAt("2026-09-06T00:10:10.000Z")).toMatchObject({ kind: "ok" });
      // A lost async invocation leaves the endpoint discoverable next minute.
      ctx.setDrop(true);
      await ctx.passAt("2026-09-06T00:11:00.000Z");
      expect(
        (await readCoordinationState(ctx.store, scope))?.terminalTickDelivered,
      ).toBeUndefined();
      ctx.setDrop(false);
      const publish = vi
        .spyOn(ctx.repository, "publishCoordinationScore")
        .mockRejectedValue(new Error("test delivery outage"));
      await ctx.passAt("2026-09-06T00:12:00.000Z");
      const committed = await readCoordinationState(ctx.store, scope);
      expect(committed?.terminalTickDelivered).toBe(true);
      expect(committed?.pendingScores).toBeDefined();
      const final = committed?.state as CryptoBattleState;
      expect(final.phase).toBe("ended");
      expect(final.nowMs).toBe(early ? 590_000 : 600_000);
      // The engine prunes old terminal Orders; retained ones record the deadline cause.
      expect(final.contracts.filter((order) => order.status === "open")).toEqual([]);
      for (const order of final.contracts.filter((order) =>
        open.some((previous) => previous.id === order.id),
      )) {
        expect(order).toMatchObject({ status: "expired", expiryCause: "deadline" });
      }
      for (const id of ["red", "blue"])
        expect(final.teams[id].score).toBe(
          before.teams[id].score -
            15 *
              (open.filter((order) => order.teamId === id).length +
                final.teams[id].issuedOrderCount -
                before.teams[id].issuedOrderCount),
        );
      expect(final.endgameLightning).toMatchObject({
        status: "awarded",
        cards: { red: { status: "unused-expired" }, blue: { status: "unused-expired" } },
      });
      publish.mockRestore();
      const terminal = required(ctx.batches.at(-1));
      // Concurrent duplicates race via the existing state/version and score CAS.
      await Promise.all([
        handleCoordinationTickBatch(ctx.deps, terminal),
        handleCoordinationTickBatch(ctx.deps, terminal),
      ]);
      // An older active invocation arriving last cannot reopen a generic or crypto match.
      await handleCoordinationTickBatch(ctx.deps, ctx.batches[0]);
      await ctx.passAt("2026-09-06T00:13:00.000Z");
      const saved = await readCoordinationState(ctx.store, scope);
      expect(saved?.state).toEqual(final);
      expect(saved?.version).toBe(committed?.version);
      expect(saved?.expiresAt).toBe(committed?.expiresAt);
      expect(saved?.pendingScores).toBeUndefined();
      for (const id of ["red", "blue"]) {
        expect((await ctx.repository.getDeployment(id))?.score).toBe(final.teams[id].score);
        const history = await ctx.repository.listScoreEvents(id, { pageSize: 100 });
        expect(history.filter((row) => row.occurredAt === terminal.nowIso)).toHaveLength(1);
      }
      const freshRepository =
        backend === "SQL"
          ? new SqlDeploymentsRepository(ctx.sql)
          : new DynamoDbDeploymentsRepository(ctx.ddb, "Deployments");
      const freshStore = {
        ...ctx.store,
        runtime: {
          ...ctx.store.runtime,
          resolveDeploymentsRepository: async () => freshRepository,
        },
      };
      expect(await readCoordinationState(freshStore, scope)).toEqual(saved);
    },
  );

  it("records a no-op endpoint once, blocks delayed ops, and does not create absent ended state", async () => {
    const tick = vi.fn((state: unknown) => state);
    const ctx = await setup(backend, { ...clockPlugin, tick });
    await ctx.passAt(endsAt);
    expect(await readCoordinationState(ctx.store, scope)).toBeUndefined();
    expect(tick).not.toHaveBeenCalled();
    await writeCoordinationState(ctx.store, scope, { phase: "running" }, 0, startsAt);
    await ctx.passAt(endsAt);
    const saved = await readCoordinationState(ctx.store, scope);
    expect(saved?.terminalTickDelivered).toBe(true);
    await handleCoordinationTickBatch(ctx.deps, required(ctx.batches.at(-1)));
    await ctx.passAt("2026-09-06T00:11:00.000Z");
    expect(tick).toHaveBeenCalledOnce();
    expect(await readCoordinationState(ctx.store, scope)).toEqual(saved);
    expect(
      await dispatchCoordinationOp(ctx.store, clockPlugin, {
        scope,
        ctx: { eventId: key.eventId, teamIds: ["red"] },
        teamId: "red",
        op: {},
        nowIso: startsAt,
        fallbackProjection: {},
      }),
    ).toEqual({ kind: "rejected", error: "event_ended" });
  });

  it("commits one settlement under concurrent terminal transitions and ignores a delayed generic tick", async () => {
    interface State {
      at: number;
      score: number;
      settlements: number;
    }
    const tick = vi.fn((state: State, at: number, timing?: { matchDurationMs?: number }) => ({
      at,
      score: state.score - (at === timing?.matchDurationMs ? 15 : 0),
      settlements: state.settlements + (at === timing?.matchDurationMs ? 1 : 0),
    }));
    const plugin: CoordinationPlugin<State, unknown> = {
      ...clockPlugin,
      initialState: () => ({ at: 0, score: 100, settlements: 0 }),
      tick,
      teamScores: (state) => ({ red: state.score }),
    };
    const ctx = await setup(backend, plugin);
    await ctx.repository.putDeployment({ ...deployment, score: 100, coordinationSubtotal: 100 });
    await writeCoordinationState(
      ctx.store,
      scope,
      plugin.initialState({ eventId: key.eventId, teamIds: ["red"] }),
      0,
      startsAt,
    );
    const batch: CoordinationTickBatch = {
      action: "coordination-tick",
      nowIso: endsAt,
      targets: [
        {
          tenantId: key.tenantId,
          eventId: key.eventId,
          moduleRef: "battle",
          eventNowMs: 800_000,
          teamIds: ["red"],
        },
      ],
    };
    // Hold both readers at version 1 so this really exercises the transition CAS.
    const read = ctx.repository.readCoordinationState.bind(ctx.repository);
    let release = () => {
      throw new Error("Barrier not initialized");
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readers = 0;
    const spy = vi
      .spyOn(ctx.repository, "readCoordinationState")
      .mockImplementation(async (key) => {
        const row = await read(key);
        if (readers < 2) {
          readers += 1;
          if (readers === 2) release();
          await barrier;
        }
        return row;
      });
    const results = await Promise.all([
      handleCoordinationTickBatch(ctx.deps, batch),
      handleCoordinationTickBatch(ctx.deps, batch),
    ]);
    spy.mockRestore();
    expect(results.reduce((sum, result) => sum + result.written, 0)).toBe(1);
    const saved = await readCoordinationState(ctx.store, scope);
    expect(saved).toMatchObject({
      version: 2,
      terminalTickDelivered: true,
      state: { at: 600_000, score: 85, settlements: 1 },
    });
    expect(await ctx.repository.listScoreEvents("red", { pageSize: 100 })).toHaveLength(1);
    await handleCoordinationTickBatch(ctx.deps, {
      ...batch,
      nowIso: "2026-09-06T00:05:00.000Z",
      targets: batch.targets.map((target) => ({ ...target, eventNowMs: 280_000 })),
    });
    expect(await readCoordinationState(ctx.store, scope)).toEqual(saved);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a finalized state discovered only after acquiring the initialization lease", async () => {
    const tick = vi.fn(clockPlugin.tick);
    const ctx = await setup(backend, { ...clockPlugin, tick });
    await writeCoordinationState(
      ctx.store,
      scope,
      { phase: "ended", at: 600_000 },
      0,
      startsAt,
      1,
      undefined,
      false,
      undefined,
      true,
    );
    const saved = await readCoordinationState(ctx.store, scope);
    // Another initializer/finalizer wins after the active tick's initial absent read.
    const read = vi.spyOn(ctx.repository, "readCoordinationState").mockResolvedValueOnce(undefined);
    const touch = vi.spyOn(ctx.repository, "touchCoordinationState");
    const write = vi.spyOn(ctx.repository, "writeCoordinationState");
    await handleCoordinationTickBatch(ctx.deps, {
      action: "coordination-tick",
      nowIso: "2026-09-06T00:05:00.000Z",
      targets: [
        {
          tenantId: key.tenantId,
          eventId: key.eventId,
          moduleRef: "battle",
          eventNowMs: 280_000,
          teamIds: ["red"],
        },
      ],
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(tick).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await readCoordinationState(ctx.store, scope)).toEqual(saved);
  });

  it.each([undefined, startsAt, "2026-09-05T00:00:00.000Z"])(
    "does not repeatedly dispatch a round without a positive explicit duration (%s)",
    async (end) => {
      const ctx = await setup(backend, clockPlugin);
      await ctx.events.putEvent({ ...event, endsAt: end });
      await writeCoordinationState(ctx.store, scope, { phase: "running" }, 0, startsAt);
      await ctx.passAt("2026-10-08T00:00:00.000Z");
      await ctx.passAt("2026-10-08T00:01:00.000Z");
      expect(ctx.invoke).not.toHaveBeenCalled();
      expect((await readCoordinationState(ctx.store, scope))?.version).toBe(1);
    },
  );

  it("keeps a paused READY event paused even after its scheduled end", async () => {
    const tick = vi.fn(clockPlugin.tick);
    const ctx = await setup(backend, { ...clockPlugin, tick });
    await writeCoordinationState(ctx.store, scope, { phase: "running" }, 0, startsAt);
    await ctx.events.putEvent({ ...event, scoringLocked: true });
    await ctx.passAt(endsAt);
    await handleCoordinationTickBatch(ctx.deps, {
      action: "coordination-tick",
      nowIso: endsAt,
      targets: [
        {
          tenantId: key.tenantId,
          eventId: key.eventId,
          moduleRef: "battle",
          eventNowMs: 600_000,
          teamIds: ["red"],
        },
      ],
    });
    expect(tick).not.toHaveBeenCalled();
    expect((await readCoordinationState(ctx.store, scope))?.terminalTickDelivered).toBeUndefined();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test value");
  return value;
}
