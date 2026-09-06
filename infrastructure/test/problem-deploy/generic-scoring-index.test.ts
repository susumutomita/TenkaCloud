import {
  BatchGetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository.js";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1424: generic scoring dispatcher Lambda (index.ts) の
 * orchestration 層 (handler / processDeployment / applyKindResult /
 * appendKindScoreEvents / fetchScoringLockedMap / queryOverridesForDeployment / parsePhasesEnv)
 * を pin する。 既存の kind / reconciler 単体テスト群は sibling module を直接叩いており
 * index.ts の scan-loop + dispatch glue を通っていなかったため 44% branch だった。
 *
 * 方針: buildSharedResources / reconcileEventStatuses / 4 kind handler / isScoringActive を
 * mock。 DDB は command 種別で分岐する fake。 残り (processDeployment 等の純 glue) は実物を通す。
 *
 * [Issue #2441 / Phase B3] `appendKindScoreEvents` no longer calls the retired
 * `writeScoreEvent` I/O function directly — it resolves the Deployments seam and
 * calls `repository.appendScoreEvent`, which issues a `PutCommand` through the
 * same fake `ddb`. Score-event assertions below observe that `PutCommand`
 * instead of a mocked `writeScoreEvent`.
 */
const EVENTS_TABLE = "TestEvents";
const mocks = vi.hoisted(() => ({
  buildSharedResources: vi.fn(),
  reconcileEventStatuses: vi.fn(),
  reconcileRuntimeStatuses: vi.fn(),
  reconcileDeployStatusMaintenance: vi.fn(),
  dispatchCompositeReadyTargets: vi.fn(),
  isScoringActive: vi.fn(),
  runUptimeFlatKind: vi.fn(),
  runUptimeMultiKind: vi.fn(),
  runPhasedPollingKind: vi.fn(),
  runAttackDetectionKind: vi.fn(),
  coordinationCollect: vi.fn(),
  coordinationCollectRecovery: vi.fn(),
  coordinationRun: vi.fn(),
  createCoordinationTickPass: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/shared", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildSharedResources: mocks.buildSharedResources,
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler", () => ({
  reconcileEventStatuses: mocks.reconcileEventStatuses,
  resolveEventStatusTransition: vi.fn(),
}));
vi.mock(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/runtime-status-reconciler",
  () => ({
    reconcileRuntimeStatuses: mocks.reconcileRuntimeStatuses,
  }),
);
vi.mock(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler",
  () => ({
    reconcileDeployStatusMaintenance: mocks.reconcileDeployStatusMaintenance,
  }),
);
vi.mock(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-ready-dispatch",
  () => ({
    dispatchCompositeReadyTargets: mocks.dispatchCompositeReadyTargets,
  }),
);
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-active", () => ({
  isScoringActive: mocks.isScoringActive,
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-flat", () => ({
  runUptimeFlatKind: mocks.runUptimeFlatKind,
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-multi", () => ({
  runUptimeMultiKind: mocks.runUptimeMultiKind,
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/phased-polling", () => ({
  runPhasedPollingKind: mocks.runPhasedPollingKind,
}));
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/attack-detection", () => ({
  runAttackDetectionKind: mocks.runAttackDetectionKind,
}));
// [#2324] coordination tick glue は本 index test では mock し、 handler が per-page で
// collect し scan 後に run すること だけを pin する (= tick 本体は coordination-tick.test.ts で網羅)。
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick", () => ({
  createCoordinationTickPass: mocks.createCoordinationTickPass,
  parseCoordinationProblemIds: vi.fn(() => new Set()),
}));
vi.mock(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick-dispatch",
  () => ({
    createLambdaTickInvoker: vi.fn(() => async () => undefined),
  }),
);

const { handler, queryOverridesForDeployment, parsePhasesEnv } = await import(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
);

const EMPTY_RESULT = { scoreDelta: 0, scoreEvents: [] };
const FULL_RESULT = {
  scoreDelta: 10,
  scoreEvents: [{ source: "uptime", points: 10, occurredAt: "2026-06-01T00:00:00Z" }],
  lastResult: "ok",
  endpointsHealthJson: "{}",
  // [#2422] uptime-multi の直近サイクル attack-probe snapshot も 1 UpdateItem で書き戻す。
  attackProbesJson: JSON.stringify({
    checkedAt: "2026-06-01T00:00:00Z",
    probes: [{ outcome: "landed", penalty: 60 }],
  }),
  postureJson: JSON.stringify({ db_present: true, auth_enabled: false }),
  platform: "posture-1",
  newState: { attackCount: 1 },
};

// 1 invocation ぶんの DDB 応答を command 種別で出し分ける fake。
const cfg = {
  scanPages: [] as Array<Record<string, unknown>>,
  batchRows: [] as Array<Record<string, unknown>>,
  batchThrows: false,
  batchThrowString: false,
  batchNoResponses: false,
  queryItems: [] as Array<Record<string, unknown>>,
  queryThrows: false,
  // [Issue #2441 / Phase B3] score-event append now issues a PutCommand through
  // this same fake (`appendKindScoreEvents` → `appendScoreEvent`).
  putThrows: false,
  putThrowString: false,
};
function handleBatchGetCommand(): object {
  if (cfg.batchThrows) throw new Error("batch boom");
  // 非 Error throw: String(err) 防御枝を踏ませるため意図的に string を投げる。
  if (cfg.batchThrowString) throw "batch string boom";
  if (cfg.batchNoResponses) return {}; // Responses undefined → ?? [] path
  return { Responses: { [EVENTS_TABLE]: cfg.batchRows } };
}

function handleQueryCommand(): object {
  if (cfg.queryThrows) throw new Error("query boom");
  return { Items: cfg.queryItems };
}

// [Issue #2441 / Phase B3] score-event append now issues a PutCommand through this
// same fake (`appendKindScoreEvents` → `appendScoreEvent`).
function handlePutCommand(): object {
  if (cfg.putThrows) throw new Error("score write boom");
  // 非 Error throw: String(err) 防御枝を踏ませるため意図的に string を投げる。
  if (cfg.putThrowString) throw "plain score fail";
  return {};
}

const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: command union を instanceof で分岐する fake。
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof ScanCommand) return cfg.scanPages.shift() ?? { Items: [] };
    if (cmd instanceof BatchGetCommand) return handleBatchGetCommand();
    if (cmd instanceof QueryCommand) return handleQueryCommand();
    if (cmd instanceof UpdateCommand) return {};
    if (cmd instanceof PutCommand) return handlePutCommand();
    return {};
  }),
};

let shared: Record<string, unknown>;
const baseItem = () => ({
  PK: "DEP#1",
  jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
  problemId: "p1",
  tenantId: "t1",
  teamId: "team1",
  eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ",
  expiresAt: 123,
  status: "COMPLETE",
});
/** 1 deployment を scan 1 page で流す handler 実行 helper。 */
const runWith = async (item: Record<string, unknown>) => {
  cfg.scanPages = [{ Items: [item], LastEvaluatedKey: undefined }];
  await handler();
};

beforeEach(() => {
  vi.clearAllMocks();
  cfg.scanPages = [];
  cfg.batchRows = [];
  cfg.batchThrows = false;
  cfg.batchThrowString = false;
  cfg.batchNoResponses = false;
  cfg.queryItems = [];
  cfg.queryThrows = false;
  cfg.putThrows = false;
  cfg.putThrowString = false;
  mocks.isScoringActive.mockReturnValue(true);
  mocks.reconcileEventStatuses.mockResolvedValue(undefined);
  mocks.reconcileRuntimeStatuses.mockResolvedValue(undefined);
  mocks.dispatchCompositeReadyTargets.mockResolvedValue(undefined);
  // [#2068 / #2747] run the injected per-target reconciler and DAG-continuation callback (so
  // reconcileRuntimeStatuses / dispatchCompositeReadyTargets are still exercised) but skip the
  // real composite parent scan in this index test.
  mocks.reconcileDeployStatusMaintenance.mockImplementation(
    async (
      _deps: unknown,
      _nowIso: unknown,
      perTarget: () => Promise<void>,
      dispatchReadyTargets?: () => Promise<void>,
    ) => {
      await perTarget();
      await dispatchReadyTargets?.();
    },
  );
  mocks.runUptimeFlatKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runUptimeMultiKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runPhasedPollingKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runAttackDetectionKind.mockReturnValue(EMPTY_RESULT); // sync, not awaited
  mocks.coordinationRun.mockResolvedValue(undefined);
  mocks.coordinationCollect.mockReturnValue(undefined);
  mocks.createCoordinationTickPass.mockReturnValue({
    collect: mocks.coordinationCollect,
    collectRecovery: mocks.coordinationCollectRecovery,
    run: mocks.coordinationRun,
  });
  shared = {
    runtime: makeTestControlDataRuntime(),
    ddb,
    deploymentsTableName: "TestDeployments",
    eventsTableName: EVENTS_TABLE,
    endpointsTableName: "TestEndpoints",
    problemsScoring: {},
    problemsEndpoints: {},
  };
  mocks.buildSharedResources.mockImplementation(() => shared);
  process.env.BATTLE_PROBLEMS_PHASES = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("handler scan loop", () => {
  it("runs already-collected coordination targets while preserving a SQL recovery query rejection", async () => {
    const sql = makeSqliteExecutor();
    const repository = new SqlDeploymentsRepository(sql);
    const complete = {
      ...baseItem(),
      teamName: "Team 1",
      teamLoginKey: "fixture-key",
      namePrefix: "fixture-team",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      createdAt: "2026-09-06T00:00:00Z",
      updatedAt: "2026-09-06T00:00:00Z",
    };
    await repository.putDeployment(complete);
    const failure = new Error("SQL recovery query unavailable");
    const all = sql.all.bind(sql);
    const select = vi.spyOn(sql, "all").mockImplementation((query, params) => {
      // Leave the COMPLETE query and its actual callback intact; fail only the added recovery query.
      if (query.includes("FROM coordination_state_scoped")) return Promise.reject(failure);
      return all(query, params);
    });
    shared.runtime = {
      ...makeTestControlDataRuntime(),
      resolveDeploymentsRepository: async () => repository,
    };
    try {
      await expect(handler()).rejects.toBe(failure);
      expect(mocks.coordinationCollect).toHaveBeenCalledWith(
        [expect.objectContaining({ jobId: complete.jobId, status: "COMPLETE" })],
        expect.any(String),
      );
      expect(
        select.mock.calls.some(([query]) => query.includes("FROM coordination_state_scoped")),
      ).toBe(true);
      expect(mocks.coordinationCollectRecovery).not.toHaveBeenCalled();
      expect(mocks.coordinationRun).toHaveBeenCalledOnce();
      expect(mocks.coordinationRun.mock.invocationCallOrder[0]).toBeGreaterThan(
        mocks.coordinationCollect.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mocks.reconcileEventStatuses).toHaveBeenCalledOnce();
      expect(mocks.reconcileRuntimeStatuses).toHaveBeenCalledOnce();
    } finally {
      select.mockRestore();
    }
  });

  it("routes pending host scopes separately from COMPLETE deployments in the same scan", async () => {
    const scope = { tenantId: "t1", eventId: "ev1", problemId: "p1", runId: "run1" };
    cfg.scanPages = [
      {
        Items: [
          baseItem(),
          {
            PK: "COORD#t1#ev1#p1#run1",
            SK: "STATE",
            coordinationScoresPending: true,
            coordinationRecoveryScope: scope,
            state: { secret: "must-not-be-dispatched" },
          },
        ],
      },
    ];
    await handler();
    expect(mocks.coordinationCollect).toHaveBeenCalledWith(
      [expect.objectContaining({ jobId: baseItem().jobId })],
      expect.any(String),
    );
    expect(mocks.coordinationCollectRecovery).toHaveBeenCalledWith([scope]);
    expect(mocks.coordinationRun).toHaveBeenCalledOnce();
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof ScanCommand)).toHaveLength(1);
  });

  it("should page through the scan until LastEvaluatedKey is empty and await reconcile", async () => {
    cfg.scanPages = [
      { Items: [], LastEvaluatedKey: { PK: "x" } },
      { Items: [], LastEvaluatedKey: undefined },
    ];
    await handler();
    const scans = ddb.send.mock.calls.filter((c) => c[0] instanceof ScanCommand);
    expect(scans).toHaveLength(2);
    expect(mocks.reconcileEventStatuses).toHaveBeenCalledTimes(1);
    // [#1410-1412] 非 AWS runtime reconciler も 1 tick で 1 回 await される。
    expect(mocks.reconcileRuntimeStatuses).toHaveBeenCalledTimes(1);
    // [#2747] Composite DAG continuation runs once per tick, after the per-target reconciler.
    expect(mocks.dispatchCompositeReadyTargets).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchCompositeReadyTargets).toHaveBeenCalledWith(shared, expect.any(Number));
  });

  it("should swallow a dispatchCompositeReadyTargets failure without throwing (#2747)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dispatchCompositeReadyTargets.mockRejectedValueOnce(new Error("dispatch boom"));
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] dispatchCompositeReadyTargets failed",
      expect.objectContaining({ message: "dispatch boom" }),
    );
    warn.mockRestore();
  });

  it("should record a generic reason when dispatchCompositeReadyTargets rejects with a non-Error value (#2747)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dispatchCompositeReadyTargets.mockRejectedValueOnce("dispatch string rejection");
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] dispatchCompositeReadyTargets failed",
      expect.objectContaining({ message: "dispatch string rejection" }),
    );
    warn.mockRestore();
  });

  it("should swallow a reconcileDeployStatusMaintenance failure without throwing (#2068)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reconcileDeployStatusMaintenance.mockRejectedValueOnce(new Error("parent scan boom"));
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] reconcileCompositeParents failed",
      expect.objectContaining({ message: "parent scan boom" }),
    );
    warn.mockRestore();
  });

  it("should record a generic reason when reconcileDeployStatusMaintenance rejects with a non-Error value (#2068)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reconcileDeployStatusMaintenance.mockRejectedValueOnce("parent scan string rejection");
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] reconcileCompositeParents failed",
      expect.objectContaining({ message: "parent scan string rejection" }),
    );
    warn.mockRestore();
  });

  it("should swallow a reconcileRuntimeStatuses failure without throwing (#1410-1412)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reconcileRuntimeStatuses.mockRejectedValueOnce(new Error("runtime reconcile boom"));
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] reconcileRuntimeStatuses failed",
      expect.objectContaining({ message: "runtime reconcile boom" }),
    );
    warn.mockRestore();
  });

  it("should record a generic reason when reconcileRuntimeStatuses rejects with a non-Error value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reconcileRuntimeStatuses.mockRejectedValueOnce("runtime string rejection");
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] reconcileRuntimeStatuses failed",
      expect.objectContaining({ message: "runtime string rejection" }),
    );
    warn.mockRestore();
  });

  it("should swallow a reconcile failure without throwing", async () => {
    mocks.reconcileEventStatuses.mockRejectedValueOnce(new Error("reconcile boom"));
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
  });

  it("should collect coordination tick targets per page and run the tick once (#2324)", async () => {
    cfg.scanPages = [
      { Items: [], LastEvaluatedKey: { PK: "x" } },
      { Items: [], LastEvaluatedKey: undefined },
    ];
    await handler();
    expect(mocks.createCoordinationTickPass).toHaveBeenCalledTimes(1);
    expect(mocks.coordinationCollect).toHaveBeenCalledTimes(2); // once per scan page
    expect(mocks.coordinationRun).toHaveBeenCalledTimes(1); // after the scan drains
  });

  it("should swallow a non-Error reconcile rejection (String(err) branch)", async () => {
    mocks.reconcileEventStatuses.mockRejectedValueOnce("plain reconcile fail");
    cfg.scanPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await expect(handler()).resolves.toBeUndefined();
  });

  it("should default to [] when a scan page omits Items", async () => {
    cfg.scanPages = [{ LastEvaluatedKey: undefined }]; // out.Items undefined → ?? [] path
    await expect(handler()).resolves.toBeUndefined();
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });
});

describe("processDeployment guard branches", () => {
  it("should skip a legacy deployment missing problemId/tenantId/teamId", async () => {
    await runWith({ PK: "DEP#1", status: "COMPLETE" });
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should skip when scoring is not active", async () => {
    mocks.isScoringActive.mockReturnValue(false);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith(baseItem());
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should skip a locked event (fetchScoringLockedMap via BatchGet)", async () => {
    cfg.batchRows = [{ eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ", scoringLocked: true }];
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith(baseItem());
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should treat the whole batch as locked when BatchGet fails (fail-closed)", async () => {
    cfg.batchThrows = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith(baseItem())).resolves.toBeUndefined();
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should proceed when lock rows do not match (non-string id / not locked)", async () => {
    cfg.batchRows = [
      { eventId: 123, scoringLocked: true }, // non-string id → ignored
      { eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ", scoringLocked: false }, // not locked → ignored
    ];
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith(baseItem());
    expect(mocks.runUptimeFlatKind).toHaveBeenCalledTimes(1);
  });

  it("should proceed when BatchGet returns no Responses payload", async () => {
    cfg.batchNoResponses = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith(baseItem());
    expect(mocks.runUptimeFlatKind).toHaveBeenCalledTimes(1);
  });

  it("should fail-closed on a non-Error BatchGet rejection (String(err) branch)", async () => {
    cfg.batchThrowString = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith(baseItem())).resolves.toBeUndefined();
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should fail loudly (not fail-closed) on a CONTROL_DATA_BACKEND config error", async () => {
    // [#2438 review] resolveEventsRepository() must be resolved outside the fail-closed
    // try/catch — a bad backend selection is a setup bug, not a transient read failure,
    // and must not be silently swallowed into "treat batch as locked".
    // [#2450] The seam is now an async resolver (controlDataRuntime). Selecting turso without
    // TURSO_DATABASE_URL still fails loudly, but now at env validation (before the libSQL
    // client is built), so the surfaced message is the missing-env one rather than the old
    // sync-factory "SqlExecutor" error. The fail-loud (not fail-closed) contract is unchanged.
    // [#2527 Slice 4] The backend selection is injected via the shared runtime (the handler no
    // longer reads the module-global singleton), so this test injects a turso-selecting runtime
    // through the mocked buildSharedResources return instead of flipping process.env.
    shared.runtime = makeTestControlDataRuntime({ CONTROL_DATA_BACKEND: "turso" });
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith(baseItem())).rejects.toThrow(/TURSO_DATABASE_URL is required/);
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should skip a problem with no scoring config", async () => {
    shared.problemsScoring = {};
    await runWith({ ...baseItem(), eventId: undefined });
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should skip the flag kind in the polling path", async () => {
    shared.problemsScoring = { p1: { kind: "flag" } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(mocks.runUptimeFlatKind).not.toHaveBeenCalled();
  });

  it("should skip an unknown kind", async () => {
    shared.problemsScoring = { p1: { kind: "mystery" } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
  });
});

describe("kind dispatch", () => {
  it.each([
    ["uptime-flat", () => mocks.runUptimeFlatKind],
    ["uptime", () => mocks.runUptimeFlatKind],
    ["uptime-multi", () => mocks.runUptimeMultiKind],
    ["phased-polling", () => mocks.runPhasedPollingKind],
    ["attack-detection", () => mocks.runAttackDetectionKind],
  ])("should dispatch %s to its kind handler", async (kind, getMock) => {
    shared.problemsScoring = { p1: { kind } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(getMock()).toHaveBeenCalledTimes(1);
  });

  it("should pass filtered endpoint overrides to the kind handler", async () => {
    cfg.queryItems = [
      { slot: "a", overrideUrl: "https://x" },
      { slot: "b" }, // no overrideUrl → filtered out
    ];
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(mocks.runUptimeFlatKind.mock.calls[0][0].overrides).toEqual([
      { slot: "a", overrideUrl: "https://x" },
    ]);
  });

  it("should skip the override query when the endpoints table is unset", async () => {
    shared.endpointsTableName = "";
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof QueryCommand)).toBe(false);
    expect(mocks.runUptimeFlatKind.mock.calls[0][0].overrides).toEqual([]);
  });

  it("should isolate a kind-handler/override failure to one deployment", async () => {
    cfg.queryThrows = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
  });

  it("should isolate a non-Error kind-handler rejection (String(err) branch)", async () => {
    mocks.runUptimeFlatKind.mockRejectedValueOnce("plain kind fail");
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
  });

  it("should supply phases from BATTLE_PROBLEMS_PHASES to phased-polling", async () => {
    process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({
      p1: [{ name: "warmup", afterMinutes: 0 }],
    });
    shared.problemsScoring = { p1: { kind: "phased-polling" } };
    await runWith({ ...baseItem(), eventId: undefined });
    expect(mocks.runPhasedPollingKind.mock.calls[0][0].phases).toHaveLength(1);
  });
});

describe("applyKindResult / appendKindScoreEvents", () => {
  it("should write a full result (ADD score + SET fields) and append score events", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    const update = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0].input;
    expect(update.UpdateExpression).toContain("ADD score :pts");
    expect(update.UpdateExpression).toContain("lastResult = :lr");
    expect(update.UpdateExpression).toContain("endpointsHealth = :health");
    // [#2422] attackProbes snapshot column is threaded through apply-kind-result.
    expect(update.UpdateExpression).toContain("attackProbes = :attackProbes");
    expect(update.ExpressionAttributeValues?.[":attackProbes"]).toBe(FULL_RESULT.attackProbesJson);
    expect(update.UpdateExpression).toContain("posture = :posture");
    expect(update.UpdateExpression).toContain("platform = :platform");
    expect(update.UpdateExpression).toContain("scoringState = :state");
    expect(update.ExpressionAttributeValues?.[":posture"]).toBe(
      JSON.stringify({ db_present: true, auth_enabled: false }),
    );
    expect(update.ExpressionAttributeValues?.[":platform"]).toBe("posture-1");
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof PutCommand)).toHaveLength(1);
  });

  it("should write a zero-delta result without ADD and append nothing", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(EMPTY_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    const update = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0].input;
    expect(update.UpdateExpression).not.toContain("ADD score");
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should still write when PK is absent (Phase B3: Scan rows carry no physical PK)", async () => {
    // [Issue #2441 / Phase B3] `item` now flows from
    // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
    // `DeploymentRecord` never carries the physical `PK` — `applyKindResult`'s
    // `!item.PK` guard was dropped (jobId alone is the precondition), so a
    // missing PK no longer skips the write. Pre-B3 this asserted the opposite
    // (`toBe(false)`) because the raw Scan item still carried PK/absence of it
    // gated the legacy UpdateItem path.
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), PK: undefined, eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(true);
  });

  it("should skip the write and score events when jobId is missing (default expiresAt path)", async () => {
    // [Issue #2441 / Phase B2] `applyKindResult` now calls the Deployments write
    // seam (`applyKindScoringResult(jobId, ...)`), which derives the physical
    // key from `jobId` itself — there is no longer a raw-PK write path that can
    // run without one. Every real Scan row always carries `jobId` (written at
    // deploy time, never removed), so this tightens an unreachable-in-production
    // edge case rather than changing real behavior; pre-seam this asserted the
    // opposite (`toBe(true)`) because the legacy code keyed the UpdateItem off
    // `item.PK` directly and only `appendKindScoreEvents` itself guarded on `jobId`.
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), jobId: undefined, expiresAt: undefined, eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should default expiresAt to 0 when the deployment lacks one", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), expiresAt: undefined, eventId: undefined });
    const put = ddb.send.mock.calls.find((c) => c[0] instanceof PutCommand)?.[0];
    expect(put).toBeDefined();
    expect(put.input.Item.expiresAt).toBe(0); // parent.expiresAt default
  });

  it("should isolate a score-event append failure to one deployment", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    cfg.putThrows = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof PutCommand)).toHaveLength(1);
  });

  it("should isolate a non-Error score-event append rejection (String(err) branch)", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    cfg.putThrowString = true;
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof PutCommand)).toHaveLength(1);
  });
});

describe("queryOverridesForDeployment (exported)", () => {
  it("should return [] when the table name is empty", async () => {
    const out = await queryOverridesForDeployment(
      makeTestControlDataRuntime(),
      // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
      {} as any,
      "",
      "t",
      "team",
      "p",
    );
    expect(out).toEqual([]);
  });

  it("should filter to rows with a non-empty overrideUrl", async () => {
    const fakeDdb = {
      send: vi.fn().mockResolvedValue({
        Items: [
          { slot: "a", overrideUrl: "https://x" },
          { slot: "b", overrideUrl: "" },
          { slot: "c" },
        ],
      }),
    };
    const out = await queryOverridesForDeployment(
      makeTestControlDataRuntime(),
      // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
      fakeDdb as any,
      "T",
      "t",
      "team",
      "p",
    );
    expect(out).toEqual([{ slot: "a", overrideUrl: "https://x" }]);
  });

  it("should default to [] when the query returns no Items", async () => {
    const fakeDdb = { send: vi.fn().mockResolvedValue({}) };
    expect(
      await queryOverridesForDeployment(
        makeTestControlDataRuntime(),
        // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
        fakeDdb as any,
        "T",
        "t",
        "team",
        "p",
      ),
    ).toEqual([]);
  });

  it("should wrap a query error with context", async () => {
    const fakeDdb = { send: vi.fn().mockRejectedValue(new Error("ddb down")) };
    await expect(
      queryOverridesForDeployment(
        makeTestControlDataRuntime(),
        // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
        fakeDdb as any,
        "T",
        "t",
        "team",
        "p",
      ),
    ).rejects.toThrow(/queryOverrides failed for t\/team\/p/);
  });

  it("should stringify a non-Error rejection in the wrapped message", async () => {
    const fakeDdb = { send: vi.fn().mockRejectedValue("plain string failure") };
    await expect(
      queryOverridesForDeployment(
        makeTestControlDataRuntime(),
        // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
        fakeDdb as any,
        "T",
        "t",
        "team",
        "p",
      ),
    ).rejects.toThrow(/plain string failure/);
  });
});

describe("parsePhasesEnv (exported)", () => {
  it("should return {} for undefined / invalid JSON / non-object", () => {
    expect(parsePhasesEnv(undefined)).toEqual({});
    expect(parsePhasesEnv("{not json")).toEqual({});
    expect(parsePhasesEnv("[1,2,3]")).toEqual({});
    expect(parsePhasesEnv("42")).toEqual({});
  });

  it("should parse valid phase entries and drop invalid ones", () => {
    const raw = JSON.stringify({
      p1: [
        { name: "warmup", afterMinutes: 0 },
        { name: "no-after" }, // invalid: missing afterMinutes → dropped
        "not-an-object", // dropped
      ],
      p2: "not-an-array", // → [] → omitted from output
      p3: [],
    });
    expect(parsePhasesEnv(raw)).toEqual({ p1: [{ name: "warmup", afterMinutes: 0 }] });
  });

  it("should carry through a phase effect (scorePathOverride + switchPlatformToDegraded)", () => {
    const raw = JSON.stringify({
      p1: [
        {
          name: "attack",
          afterMinutes: 30,
          effect: {
            scorePathOverride: "$.attacked",
            switchPlatformToDegraded: ["edge", 5, "core"], // non-strings filtered
          },
        },
      ],
    });
    expect(parsePhasesEnv(raw)).toEqual({
      p1: [
        {
          name: "attack",
          afterMinutes: 30,
          effect: { scorePathOverride: "$.attacked", switchPlatformToDegraded: ["edge", "core"] },
        },
      ],
    });
  });

  it("should drop an effect that is not an object", () => {
    const raw = JSON.stringify({ p1: [{ name: "x", afterMinutes: 1, effect: "nope" }] });
    expect(parsePhasesEnv(raw)).toEqual({ p1: [{ name: "x", afterMinutes: 1 }] });
  });

  it("should yield an empty effect when neither field is present", () => {
    // effect は object だが scorePathOverride / switchPlatformToDegraded を持たない
    // → 両 ternary の false 枝を通り、 effect: {} になる。
    const raw = JSON.stringify({ p1: [{ name: "x", afterMinutes: 1, effect: { other: 1 } }] });
    expect(parsePhasesEnv(raw)).toEqual({ p1: [{ name: "x", afterMinutes: 1, effect: {} }] });
  });
});
