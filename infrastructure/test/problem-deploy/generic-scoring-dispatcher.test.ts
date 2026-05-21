import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Generic scoring dispatcher (= `generic-scoring-handler/index.ts` の handler) の test。
 *
 * 5 種 builtin kind の dispatch + DDB Scan + UpdateItem + score-event write を pin する。
 * 既存 hello-world-battle (= legacy `kind: "uptime"`) が新 dispatcher 経由でも同じ score を
 * 出すことを確認する **behavioral preservation** test も含む。
 */

const ddbSend = vi.fn();

vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  };
});

process.env.DEPLOYMENTS_TABLE_NAME = "TestDeployments";
process.env.EVENTS_TABLE_NAME = "TestEvents";
process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "TestEndpoints";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  ddbSend.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW_ISO = "2026-05-12T10:00:00.000Z";
function freezeNow(): () => void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  return () => vi.useRealTimers();
}

/**
 * 1 deployment 行 (= hello-world-battle、 uptime-flat legacy "uptime") を含む Scan 応答を
 * 模す helper。 採点経路全体を 1 invocation で実行し、 期待する UpdateItem (= score 加算) +
 * score-event PutItem が 1 件ずつ走ることを assert する。
 */
function sampleUptimeDeployment(over: Record<string, unknown> = {}) {
  return {
    PK: "DEPLOYMENT#JOB-HW",
    SK: "META",
    jobId: "JOB-HW",
    problemId: "hello-world-battle",
    tenantId: "tenant-acme",
    teamId: "team-1",
    eventId: "event-1",
    status: "COMPLETE",
    teamLoginKey: "KEY1",
    teamName: "alpha",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    namePrefix: "tc-hw",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    expiresAt: 9_999_999_999,
    eventStartsAt: "2026-05-12T09:00:00.000Z",
    stackOutputs: JSON.stringify({
      FrontendUrl: "https://frontend.example.com",
      ApiUrl: "https://api.example.com",
    }),
    ...over,
  };
}

describe("generic scoring dispatcher: hello-world-battle (= legacy uptime) 挙動 preservation", () => {
  it("should award +100 and write 1 score-event when scoring=uptime + all endpoints return 200", async () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({
      "hello-world-battle": {
        kind: "uptime",
        endpoints: [
          { outputKey: "FrontendUrl", path: "/", expectStatus: [200] },
          { outputKey: "ApiUrl", path: "/healthz", expectStatus: [200] },
        ],
        pointsPerSuccess: 100,
      },
    });
    process.env.PROBLEM_ENDPOINTS = JSON.stringify({});
    process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({});

    // Sequence of ddb send:
    // 1. reconcileEventStatuses Scan (= 0 Events で 1 call)
    // 2. Deployments Scan (= 1 row)
    // 3. BatchGet Events (scoringLocked) → 空
    // 4. Endpoints Query (= 0 overrides)
    // 5. UpdateItem (= score 加算)
    // 6. PutItem (= score-event 行)
    ddbSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === "ScanCommand") {
        // 最初は Events Scan, 次は Deployments Scan を distinguish — input.TableName で識別
        const tn = (cmd as { input: { TableName: string } }).input.TableName;
        if (tn === "TestEvents") return { Items: [] };
        if (tn === "TestDeployments") return { Items: [sampleUptimeDeployment()] };
      }
      if (name === "BatchGetCommand") return { Responses: { TestEvents: [] } };
      if (name === "QueryCommand") return { Items: [] };
      if (name === "UpdateCommand") return {};
      if (name === "PutCommand") return {};
      return {};
    });

    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });

    const restore = freezeNow();
    try {
      const { handler } = await import(
        "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
      );
      await handler();
    } finally {
      restore();
    }

    // UpdateItem が 1 件 (= ADD score + SET lastResult/...)
    const updateCalls = ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .filter((c) => c.constructor.name === "UpdateCommand");
    expect(updateCalls.length).toBe(1);
    const updateCmd = updateCalls[0] as {
      input: {
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(updateCmd.input.UpdateExpression).toContain("ADD score :pts");
    expect(updateCmd.input.ExpressionAttributeValues[":pts"]).toBe(100);

    // PutItem (score-event) 1 件
    const putCalls = ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string } })
      .filter((c) => c.constructor.name === "PutCommand");
    expect(putCalls.length).toBe(1);
  });

  it("should skip problemIds without scoring config (scoring disabled)", async () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({});
    process.env.PROBLEM_ENDPOINTS = JSON.stringify({});
    process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({});

    ddbSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === "ScanCommand") {
        const tn = (cmd as { input: { TableName: string } }).input.TableName;
        if (tn === "TestEvents") return { Items: [] };
        if (tn === "TestDeployments") return { Items: [sampleUptimeDeployment()] };
      }
      if (name === "BatchGetCommand") return { Responses: { TestEvents: [] } };
      return {};
    });

    const restore = freezeNow();
    try {
      const { handler } = await import(
        "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
      );
      await handler();
    } finally {
      restore();
    }
    // UpdateItem は 0 件
    expect(
      ddbSend.mock.calls.filter(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name === "UpdateCommand",
      ).length,
    ).toBe(0);
    // fetch も呼ばない (= probe 経路に入らない)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should skip and not fetch for kind=flag during polling", async () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({
      "hello-world": { kind: "flag", flagOutputKey: "X", points: 100 },
    });
    process.env.PROBLEM_ENDPOINTS = JSON.stringify({});
    process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({});

    ddbSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === "ScanCommand") {
        const tn = (cmd as { input: { TableName: string } }).input.TableName;
        if (tn === "TestEvents") return { Items: [] };
        if (tn === "TestDeployments")
          return { Items: [sampleUptimeDeployment({ problemId: "hello-world" })] };
      }
      if (name === "BatchGetCommand") return { Responses: { TestEvents: [] } };
      return {};
    });

    const restore = freezeNow();
    try {
      const { handler } = await import(
        "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
      );
      await handler();
    } finally {
      restore();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should skip scoring for events with scoringLocked=true (#558 fail-closed)", async () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({
      "hello-world-battle": {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 100,
      },
    });
    process.env.PROBLEM_ENDPOINTS = JSON.stringify({});
    process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({});

    ddbSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === "ScanCommand") {
        const tn = (cmd as { input: { TableName: string } }).input.TableName;
        if (tn === "TestEvents") return { Items: [] };
        if (tn === "TestDeployments") return { Items: [sampleUptimeDeployment()] };
      }
      if (name === "BatchGetCommand") {
        return {
          Responses: { TestEvents: [{ eventId: "event-1", scoringLocked: true }] },
        };
      }
      return {};
    });

    const restore = freezeNow();
    try {
      const { handler } = await import(
        "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
      );
      await handler();
    } finally {
      restore();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
