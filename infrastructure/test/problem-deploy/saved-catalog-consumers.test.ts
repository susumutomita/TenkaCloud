import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository.js";
import { createExecutionPluginImporter } from "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/s3-plugin-importer.js";
import { createCoordinationTickPass } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";
import { makeCoordinationScopeResolver } from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup.js";
import { revealHint } from "../../lib/problem-deploy/handlers/participant-handler/reveal-hint.js";
import {
  type ParticipantSharedResources,
  resolveParticipantCatalog,
} from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { submitFlag } from "../../lib/problem-deploy/handlers/participant-handler/submit-flag.js";
import {
  contentDigest,
  type ResolvedExecutionCatalog,
} from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";

const pluginSources = {
  A: 'export default {initialState:()=>({count:0}),validateOp:()=>({ok:true}),applyOp:s=>({count:s.count+1}),projectForTeam:s=>({version:"A",count:s.count})};',
  B: 'export default {initialState:()=>({count:0}),validateOp:()=>({ok:true}),applyOp:s=>({count:s.count+1}),projectForTeam:s=>({version:"B",count:s.count})};',
};
const sources = new Map<string, string>();
vi.mock("../../lib/problem-deploy/handlers/shared/execution-catalog.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadExecutionPluginSource: async (catalog: ResolvedExecutionCatalog) => {
    const result = sources.get(catalog.catalogKey);
    if (!result) throw new Error("Execution artifact integrity mismatch.");
    return result;
  },
}));

function catalog(
  version: keyof typeof pluginSources,
  points = 100,
  penalty = 7,
): ResolvedExecutionCatalog {
  const digest = contentDigest(pluginSources[version]);
  const key = `catalogs/${contentDigest(version)}.json`;
  sources.set(key, pluginSources[version]);
  return {
    version: 1,
    catalogKey: key,
    catalog: { p: "p" },
    scoring: {
      p: {
        kind: "flag",
        flagOutputKey: `Answer${version}`,
        points,
        hints: [{ id: "h1", label: "Hint", content: `hint ${version}`, penalty }],
      },
    },
    hints: {},
    endpoints: {},
    phases: {},
    visibility: {},
    runtimes: {},
    disruptions: {},
    writeups: {},
    provenance: {},
    coordination: { p: { plugin: "coordination.ts", scoreMode: "exclusive" } },
    plugins: { p: { key: `plugins/${digest}.mjs`, digest } },
    sources: {},
    sourceArchive: { bucket: "source", key: "archive", versionId: "saved-A" },
  };
}

function fixture() {
  const a = catalog("A");
  const b = catalog("B", 900, 90);
  const now = Date.now();
  const rows = new Map(
    [a, b].map((saved, index) => {
      const id = index ? "B" : "A";
      return [
        id,
        {
          jobId: id,
          problemId: "p",
          tenantId: "tenant",
          eventId: id,
          teamId: `team-${id}`,
          teamName: id,
          teamLoginKey: `key-${id}`,
          catalogKey: saved.catalogKey,
          status: "COMPLETE",
          score: 50,
          expiresAt: Math.floor(now / 1000) + 3600,
          createdAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now).toISOString(),
          eventStartsAt: new Date(now - 60_000).toISOString(),
          stackOutputs: JSON.stringify({
            AnswerA: "answer",
            AnswerB: "answer",
            Url: "https://example.test",
          }),
          hintsRevealed: [] as { hintId: string; penaltyApplied: number; revealedAt: string }[],
        },
      ];
    }),
  );
  const events = new Map(
    [...rows].map(([id, row]) => [
      id,
      {
        tenantId: "tenant",
        eventId: id,
        catalogKey: row.catalogKey,
        status: "RUNNING",
        startsAt: row.eventStartsAt,
        scoringLocked: false,
      },
    ]),
  );
  const appendScoreEvent = vi.fn();
  const applyFlagCorrectScore = vi.fn(async (id: string, points: number) => {
    const row = required(rows.get(id));
    row.score += points;
    return { outcome: "updated", record: { ...row } };
  });
  const applyHintPenalty = vi.fn(
    async (id: string, hint: { hintId: string; penaltyApplied: number; revealedAt: string }) => {
      const row = required(rows.get(id));
      if (row.hintsRevealed.some((entry) => entry.hintId === hint.hintId))
        return { outcome: "conflict" };
      row.score -= hint.penaltyApplied;
      row.hintsRevealed.push(hint);
      return { outcome: "updated", record: { ...row } };
    },
  );
  const repository = {
    listByTeamLoginKey: vi.fn(async (key: string) =>
      [...rows.values()].filter((row) => row.teamLoginKey === key),
    ),
    getDeployment: vi.fn(async (id: string) => rows.get(id)),
    applyFlagCorrectScore,
    applyHintPenalty,
    appendScoreEvent,
    readCoordinationRun: vi.fn(async () => undefined),
    readCoordinationState: vi.fn(async () => ({
      version: 1,
      state: { count: 5 },
      expiresAt: Math.floor(now / 1000) + 3600,
    })),
  };
  const catalogLoader = vi.fn(async (key?: string) => {
    const saved = [a, b].find((candidate) => candidate.catalogKey === key);
    if (!saved) throw new Error("execution_catalog_unpinned: recover original catalog");
    return structuredClone(saved);
  });
  const shared = {
    runtime: {
      resolveDeploymentsRepository: async () => repository,
      resolveEventsRepository: async () => ({
        getEvent: async (_tenant: string, id: string) => events.get(id),
      }),
    },
    ddb: {},
    tableName: "deployments",
    eventsTableName: "events",
    endpointsTableName: "endpoints",
    catalogLoader,
    problemsScoring: {},
    problemsEndpoints: {},
    coordinationProblemIds: [],
  } as unknown as ParticipantSharedResources;
  return { a, b, rows, events, repository, catalogLoader, shared };
}

beforeEach(() => vi.clearAllMocks());
describe("saved catalog consumer continuity", () => {
  it("charges A's hint once and awards A's points after B removed the problem", async () => {
    const f = fixture();
    expect(await revealHint(f.shared, {}, "key-A", "p", "h1")).toMatchObject({
      kind: "ok",
      content: "hint A",
      penaltyApplied: 7,
      totalScore: 43,
    });
    expect(await revealHint(f.shared, {}, "key-A", "p", "h1")).toMatchObject({
      kind: "already_revealed",
      content: "hint A",
      penaltyApplied: 7,
      totalScore: 43,
    });
    expect(await submitFlag(f.shared, {}, "key-A", "p", "answer")).toMatchObject({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 143,
    });
    expect(f.repository.applyHintPenalty).toHaveBeenCalledTimes(1);
    expect(f.repository.appendScoreEvent).toHaveBeenCalledTimes(2);
  });

  it("isolates interleaved A/B views and hides each saved answer output", async () => {
    const f = fixture();
    const [a1, b, a2] = await Promise.all([
      lookupTeamByLoginKey(f.shared, "key-A"),
      lookupTeamByLoginKey(f.shared, "key-B"),
      lookupTeamByLoginKey(f.shared, "key-A"),
    ]);
    expect(a1?.problems[0]?.scoring?.points).toBe(100);
    expect(b?.problems[0]?.scoring?.points).toBe(900);
    expect(a2).toEqual(a1);
    expect(a1?.problems[0]?.stackOutputs).not.toHaveProperty("AnswerA");
    expect(b?.problems[0]?.stackOutputs).not.toHaveProperty("AnswerB");
    expect(a1?.problems[0]?.coordinationRunId).toBe("default");
    expect(f.shared.problemsScoring).toEqual({});
  });

  it("resolves removed coordination support from A before the live B support gate", async () => {
    const f = fixture();
    const resolution = await makeCoordinationScopeResolver(f.shared, {})("key-A", "p");
    expect(resolution.kind).toBe("scope");
    if (resolution.kind !== "scope") throw new Error("expected scope");
    const module = (await required(resolution.scope.importer)("p")) as {
      default: { projectForTeam: (state: unknown) => unknown };
    };
    expect(module.default.projectForTeam({ count: 5 })).toEqual({ version: "A", count: 5 });
    expect(resolution.scope.coordinationScoreModes).toEqual({ p: "exclusive" });
  });

  it("uses the same plugin bytes on warm and cold loads and separates A/B cache entries", async () => {
    const { a, b } = fixture();
    const load = vi.fn(async (saved: ResolvedExecutionCatalog) =>
      required(sources.get(saved.catalogKey)),
    );
    const warm = createExecutionPluginImporter(load);
    const cold = createExecutionPluginImporter(load);
    const a1 = await warm(a)("p");
    const b1 = await warm(b)("p");
    const a2 = await warm(a)("p");
    const aCold = await cold(a)("p");
    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);
    expect(aCold).not.toBe(a1);
    const project = (mod: unknown) =>
      (mod as { default: { projectForTeam: (state: unknown) => unknown } }).default.projectForTeam({
        count: 5,
      });
    expect(project(aCold)).toEqual(project(a1));
    expect(project(b1)).toEqual({ version: "B", count: 5 });
    expect(load.mock.calls.map(([saved]) => saved.plugins.p?.digest)).toEqual([
      a.plugins.p?.digest,
      b.plugins.p?.digest,
      a.plugins.p?.digest,
    ]);
  });

  it("rejects missing or malformed artifacts before scoring and keeps saved status/history readable", async () => {
    const f = fixture();
    f.catalogLoader.mockRejectedValue(new Error("Execution artifact integrity mismatch."));
    await expect(revealHint(f.shared, {}, "key-A", "p", "h1")).rejects.toThrow(
      "integrity mismatch",
    );
    await expect(submitFlag(f.shared, {}, "key-A", "p", "answer")).rejects.toThrow(
      "integrity mismatch",
    );
    expect(f.repository.applyHintPenalty).not.toHaveBeenCalled();
    expect(f.repository.applyFlagCorrectScore).not.toHaveBeenCalled();
    const history = await lookupTeamByLoginKey(f.shared, "key-A");
    expect(history?.problems[0]).toMatchObject({ status: "COMPLETE", score: 50, stackOutputs: {} });
    expect(history?.problems[0]?.scoring).toBeUndefined();
  });

  it("keeps key rotation, expiry, scoring lock and current run checks live", async () => {
    const f = fixture();
    const stale = { ...required(f.rows.get("A")) };
    f.repository.listByTeamLoginKey.mockResolvedValue([stale]);
    required(f.rows.get("A")).teamLoginKey = "rotated";
    expect(await submitFlag(f.shared, {}, "key-A", "p", "answer")).toEqual({
      kind: "unauthorized",
    });
    expect(f.catalogLoader).not.toHaveBeenCalled();
    required(f.rows.get("A")).teamLoginKey = "key-A";
    required(f.rows.get("A")).expiresAt = 1;
    expect(await revealHint(f.shared, {}, "key-A", "p", "h1")).toEqual({ kind: "unauthorized" });
    required(f.rows.get("A")).expiresAt = Math.floor(Date.now() / 1000) + 3600;
    required(f.events.get("A")).scoringLocked = true;
    expect(await submitFlag(f.shared, {}, "key-A", "p", "answer")).toEqual({
      kind: "scoring_locked",
    });
    required(f.events.get("A")).scoringLocked = false;
    expect(
      await makeCoordinationScopeResolver(f.shared, {})(
        "key-A",
        "p",
        "initialize",
        new Date().toISOString(),
        "old-run",
      ),
    ).toEqual({ kind: "run_changed" });
    expect(f.repository.applyFlagCorrectScore).not.toHaveBeenCalled();
  });

  it("authenticates saved SQL deployments through the live bearer hash", async () => {
    const f = fixture();
    const repository = new SqlDeploymentsRepository(makeSqliteExecutor());
    const row = {
      ...required(f.rows.get("A")),
      namePrefix: "tc-a",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
    };
    await repository.putDeployment(row);
    const shared = {
      ...f.shared,
      runtime: { ...f.shared.runtime, resolveDeploymentsRepository: async () => repository },
    };
    expect((await lookupTeamByLoginKey(shared, "key-A"))?.problems[0]?.scoring?.points).toBe(100);
    await repository.putDeployment({ ...row, teamLoginKey: "rotated" });
    expect(await lookupTeamByLoginKey(shared, "key-A")).toBeUndefined();
    expect((await lookupTeamByLoginKey(shared, "rotated"))?.problems[0]?.jobId).toBe("A");
  });

  it("rejects unavailable plugin bytes before touching coordination state", async () => {
    const f = fixture();
    const digest = contentDigest("unavailable plugin fixture");
    f.a.plugins.p = { key: `plugins/${digest}.mjs`, digest };
    sources.delete(f.a.catalogKey);
    await expect(
      makeCoordinationScopeResolver(f.shared, {})(
        "key-A",
        "p",
        "initialize",
        new Date().toISOString(),
      ),
    ).rejects.toThrow("integrity mismatch");
    expect(f.repository.readCoordinationState).not.toHaveBeenCalled();
    expect(f.repository.applyFlagCorrectScore).not.toHaveBeenCalled();
  });
  it("refuses conflicting event/deployment pins without adopting B", async () => {
    const f = fixture();
    required(f.events.get("A")).catalogKey = f.b.catalogKey;
    await expect(resolveParticipantCatalog(f.shared, [required(f.rows.get("A"))])).rejects.toThrow(
      "catalog_pin_mismatch",
    );
    expect(f.catalogLoader).not.toHaveBeenCalled();
  });

  it("collects removed A coordination problems and recovery scopes from saved catalogs", async () => {
    const f = fixture();
    const invoke = vi.fn();
    const pass = createCoordinationTickPass(
      invoke,
      "dispatcher",
      new Set(),
      undefined,
      async (scope) => {
        const scoped = await resolveParticipantCatalog(f.shared, [scope]);
        return { problemIds: new Set(scoped.coordinationProblemIds) };
      },
    );
    await pass.collect([...f.rows.values()], new Date().toISOString());
    await pass.run(Date.now(), new Date().toISOString());
    expect(invoke.mock.calls[0]?.[1].targets).toHaveLength(2);
    expect(
      invoke.mock.calls[0]?.[1].targets.map((target: { eventId: string }) => target.eventId),
    ).toEqual(["A", "B"]);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
