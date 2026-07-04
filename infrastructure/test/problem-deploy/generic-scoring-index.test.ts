import { BatchGetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: generic scoring dispatcher Lambda (index.ts, ADR-012 Phase 3.B) の
 * orchestration 層 (handler / processDeployment / applyKindResult / buildKindResultUpdate /
 * appendKindScoreEvents / fetchScoringLockedMap / queryOverridesForDeployment / parsePhasesEnv)
 * を pin する。 既存の kind / reconciler 単体テスト群は sibling module を直接叩いており
 * index.ts の scan-loop + dispatch glue を通っていなかったため 44% branch だった。
 *
 * 方針: buildSharedResources / reconcileEventStatuses / 4 kind handler / writeScoreEvent /
 * isScoringActive を mock。 DDB は command 種別で分岐する fake。 残り (processDeployment 等の
 * 純 glue) は実物を通す。
 */
const EVENTS_TABLE = "TestEvents";
const mocks = vi.hoisted(() => ({
  buildSharedResources: vi.fn(),
  reconcileEventStatuses: vi.fn(),
  reconcileRuntimeStatuses: vi.fn(),
  reconcileDeployStatusMaintenance: vi.fn(),
  isScoringActive: vi.fn(),
  runUptimeFlatKind: vi.fn(),
  runUptimeMultiKind: vi.fn(),
  runPhasedPollingKind: vi.fn(),
  runAttackDetectionKind: vi.fn(),
  writeScoreEvent: vi.fn(),
  coordinationCollect: vi.fn(),
  coordinationRun: vi.fn(),
  createCoordinationTickPass: vi.fn(),
  publishRuntimeScoreFeed: vi.fn(),
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
vi.mock("../../lib/problem-deploy/handlers/generic-scoring-handler/runtime-score-feed", () => ({
  publishRuntimeScoreFeed: mocks.publishRuntimeScoreFeed,
}));
vi.mock(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler",
  () => ({
    reconcileDeployStatusMaintenance: mocks.reconcileDeployStatusMaintenance,
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
vi.mock("../../lib/problem-deploy/handlers/shared/score-event", () => ({
  writeScoreEvent: mocks.writeScoreEvent,
}));
// [ADR-028 / #2324] coordination tick glue は本 index test では mock し、 handler が per-page で
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
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: command union を instanceof で分岐する fake。
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof ScanCommand) return cfg.scanPages.shift() ?? { Items: [] };
    if (cmd instanceof BatchGetCommand) {
      if (cfg.batchThrows) throw new Error("batch boom");
      // 非 Error throw: String(err) 防御枝を踏ませるため意図的に string を投げる。
      if (cfg.batchThrowString) throw "batch string boom";
      if (cfg.batchNoResponses) return {}; // Responses undefined → ?? [] path
      return { Responses: { [EVENTS_TABLE]: cfg.batchRows } };
    }
    if (cmd instanceof QueryCommand) {
      if (cfg.queryThrows) throw new Error("query boom");
      return { Items: cfg.queryItems };
    }
    if (cmd instanceof UpdateCommand) return {};
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
  mocks.isScoringActive.mockReturnValue(true);
  mocks.reconcileEventStatuses.mockResolvedValue(undefined);
  mocks.reconcileRuntimeStatuses.mockResolvedValue(undefined);
  // [#2068] run the injected per-target reconciler (so reconcileRuntimeStatuses is
  // still exercised) but skip the real composite parent scan in this index test.
  mocks.reconcileDeployStatusMaintenance.mockImplementation(
    async (_deps: unknown, _nowIso: unknown, perTarget: () => Promise<void>) => {
      await perTarget();
    },
  );
  mocks.runUptimeFlatKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runUptimeMultiKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runPhasedPollingKind.mockResolvedValue(EMPTY_RESULT);
  mocks.runAttackDetectionKind.mockReturnValue(EMPTY_RESULT); // sync, not awaited
  mocks.writeScoreEvent.mockResolvedValue(undefined);
  mocks.coordinationRun.mockResolvedValue(undefined);
  mocks.coordinationCollect.mockReturnValue(undefined);
  mocks.createCoordinationTickPass.mockReturnValue({
    collect: mocks.coordinationCollect,
    run: mocks.coordinationRun,
  });
  mocks.publishRuntimeScoreFeed.mockResolvedValue(undefined);
  shared = {
    ddb,
    deploymentsTableName: "TestDeployments",
    eventsTableName: EVENTS_TABLE,
    endpointsTableName: "TestEndpoints",
    problemsScoring: {},
    problemsEndpoints: {},
  };
  mocks.buildSharedResources.mockImplementation(() => shared);
  process.env.BATTLE_PROBLEMS_PHASES = undefined;
  process.env.ALWAYS_ON_CONTROL_PLANE_URL = "https://control.example";
  process.env.RUNTIME_FEED_TOKEN_PARAMETER_NAME = "/tenkacloud/runtime/feed-token";
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("handler scan loop", () => {
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

  it("should scope an event-runtime tick and leave reconciliation to Workers Cron", async () => {
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    cfg.scanPages = [
      {
        Items: [baseItem(), { ...baseItem(), PK: "DEP#other", eventId: "other-event" }],
      },
    ];

    await handler({ eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ" });

    const scan = ddb.send.mock.calls.find((call) => call[0] instanceof ScanCommand)?.[0];
    expect(scan.input).toMatchObject({
      FilterExpression: "#status = :complete AND eventId = :eventId",
      ExpressionAttributeValues: {
        ":complete": "COMPLETE",
        ":eventId": "01HZX0K3M3K9ZQHB3MRQHBA1ZZ",
      },
    });
    expect(mocks.runUptimeFlatKind).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileEventStatuses).not.toHaveBeenCalled();
    expect(mocks.reconcileRuntimeStatuses).not.toHaveBeenCalled();
    expect(mocks.reconcileDeployStatusMaintenance).not.toHaveBeenCalled();
    expect(mocks.publishRuntimeScoreFeed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ" }),
      expect.objectContaining({ ddb }),
    );
  });

  it("should reject a blank event-runtime scope instead of running the global tick", async () => {
    await expect(handler({ eventId: "  " })).rejects.toThrow(/eventId must be non-empty/);
    expect(ddb.send).not.toHaveBeenCalled();
    expect(mocks.reconcileEventStatuses).not.toHaveBeenCalled();
    expect(mocks.publishRuntimeScoreFeed).not.toHaveBeenCalled();
  });

  it("should not retry committed scoring when the runtime score feed fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.publishRuntimeScoreFeed.mockRejectedValueOnce(new Error("feed unavailable"));
    cfg.scanPages = [{ Items: [] }];

    await expect(handler({ eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ" })).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[generic-scoring] runtime score feed failed",
      expect.objectContaining({
        eventId: "01HZX0K3M3K9ZQHB3MRQHBA1ZZ",
        message: "feed unavailable",
      }),
    );
    consoleError.mockRestore();
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

describe("applyKindResult / buildKindResultUpdate / appendKindScoreEvents", () => {
  it("should write a full result (ADD score + SET fields) and append score events", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    const update = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0].input;
    expect(update.UpdateExpression).toContain("ADD score :pts");
    expect(update.UpdateExpression).toContain("lastResult = :lr");
    expect(update.UpdateExpression).toContain("endpointsHealth = :health");
    expect(update.UpdateExpression).toContain("posture = :posture");
    expect(update.UpdateExpression).toContain("platform = :platform");
    expect(update.UpdateExpression).toContain("scoringState = :state");
    expect(update.ExpressionAttributeValues?.[":posture"]).toBe(
      JSON.stringify({ db_present: true, auth_enabled: false }),
    );
    expect(update.ExpressionAttributeValues?.[":platform"]).toBe("posture-1");
    expect(mocks.writeScoreEvent).toHaveBeenCalledTimes(1);
  });

  it("should write a zero-delta result without ADD and append nothing", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(EMPTY_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), eventId: undefined });
    const update = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0].input;
    expect(update.UpdateExpression).not.toContain("ADD score");
    expect(mocks.writeScoreEvent).not.toHaveBeenCalled();
  });

  it("should skip the write when the deployment has no PK", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), PK: undefined, eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
  });

  it("should not append score events when jobId is missing (default expiresAt path)", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), jobId: undefined, expiresAt: undefined, eventId: undefined });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(true);
    expect(mocks.writeScoreEvent).not.toHaveBeenCalled();
  });

  it("should default expiresAt to 0 when the deployment lacks one", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await runWith({ ...baseItem(), expiresAt: undefined, eventId: undefined });
    expect(mocks.writeScoreEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeScoreEvent.mock.calls[0][2].expiresAt).toBe(0); // parent.expiresAt default
  });

  it("should isolate a writeScoreEvent failure to one deployment", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    mocks.writeScoreEvent.mockRejectedValueOnce(new Error("score write boom"));
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
    expect(mocks.writeScoreEvent).toHaveBeenCalledTimes(1);
  });

  it("should isolate a non-Error writeScoreEvent rejection (String(err) branch)", async () => {
    mocks.runUptimeFlatKind.mockResolvedValueOnce(FULL_RESULT);
    mocks.writeScoreEvent.mockRejectedValueOnce("plain score fail");
    shared.problemsScoring = { p1: { kind: "uptime-flat" } };
    await expect(runWith({ ...baseItem(), eventId: undefined })).resolves.toBeUndefined();
    expect(mocks.writeScoreEvent).toHaveBeenCalledTimes(1);
  });
});

describe("queryOverridesForDeployment (exported)", () => {
  it("should return [] when the table name is empty", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
    const out = await queryOverridesForDeployment({} as any, "", "t", "team", "p");
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
    // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
    const out = await queryOverridesForDeployment(fakeDdb as any, "T", "t", "team", "p");
    expect(out).toEqual([{ slot: "a", overrideUrl: "https://x" }]);
  });

  it("should default to [] when the query returns no Items", async () => {
    const fakeDdb = { send: vi.fn().mockResolvedValue({}) };
    // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
    expect(await queryOverridesForDeployment(fakeDdb as any, "T", "t", "team", "p")).toEqual([]);
  });

  it("should wrap a query error with context", async () => {
    const fakeDdb = { send: vi.fn().mockRejectedValue(new Error("ddb down")) };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
      queryOverridesForDeployment(fakeDdb as any, "T", "t", "team", "p"),
    ).rejects.toThrow(/queryOverrides failed for t\/team\/p/);
  });

  it("should stringify a non-Error rejection in the wrapped message", async () => {
    const fakeDdb = { send: vi.fn().mockRejectedValue("plain string failure") };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: 直接呼び出し用の最小 ddb。
      queryOverridesForDeployment(fakeDdb as any, "T", "t", "team", "p"),
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
