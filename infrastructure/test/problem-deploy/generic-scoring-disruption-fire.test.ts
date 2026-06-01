import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1422 (ADR-013 Phase 2): scoring dispatcher が採点後に condition-triggered disruption を
 * 評価し、 in-account event bus に PutEvents する経路を end-to-end で pin する。
 * EventBridge + DynamoDB を mock し、 発火 / idempotency 抑制 / bus 未配線 / publish 失敗を網羅。
 */

const ddbSend = vi.fn();
const ebSend = vi.fn();

vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) } };
});
vi.mock("@aws-sdk/client-eventbridge", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-eventbridge")>(
    "@aws-sdk/client-eventbridge",
  );
  return {
    ...actual,
    EventBridgeClient: class {
      send = ebSend;
    },
  };
});

process.env.DEPLOYMENTS_TABLE_NAME = "TestDeployments";
process.env.EVENTS_TABLE_NAME = "TestEvents";
process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "TestEndpoints";

const fetchMock = vi.fn();
const NOW_ISO = "2026-05-12T10:00:00.000Z";

function sampleDeployment(over: Record<string, unknown> = {}) {
  return {
    PK: "DEPLOYMENT#JOB-1",
    SK: "META",
    jobId: "JOB-1",
    problemId: "hello-world-battle",
    tenantId: "tenant-acme",
    teamId: "team-1",
    eventId: "event-1",
    status: "COMPLETE",
    createdAt: NOW_ISO,
    eventStartsAt: "2026-05-12T09:00:00.000Z",
    expiresAt: 9_999_999_999,
    stackOutputs: JSON.stringify({ FrontendUrl: "https://frontend.example.com" }),
    ...over,
  };
}

function configureScoringAndDisruptions(): void {
  process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({
    "hello-world-battle": {
      kind: "uptime",
      endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
      pointsPerSuccess: 100,
    },
  });
  process.env.PROBLEM_ENDPOINTS = JSON.stringify({});
  process.env.BATTLE_PROBLEMS_PHASES = JSON.stringify({});
  process.env.BATTLE_PROBLEMS_DISRUPTIONS = JSON.stringify({
    "hello-world-battle": [
      {
        id: "latency",
        name: "EC2 latency",
        eventDetailType: "DegradedDisruptionFired",
        parameters: { delayMs: 200 },
        triggers: [{ kind: "team-score-above", threshold: 50 }],
      },
    ],
  });
}

function mockDdb(deploymentOver: Record<string, unknown> = {}): void {
  ddbSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === "ScanCommand") {
      const tn = (cmd as { input: { TableName: string } }).input.TableName;
      if (tn === "TestEvents") return { Items: [] };
      if (tn === "TestDeployments") return { Items: [sampleDeployment(deploymentOver)] };
    }
    if (name === "BatchGetCommand") return { Responses: { TestEvents: [] } };
    return {};
  });
}

async function runHandler(): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  try {
    const { handler } = await import(
      "../../lib/problem-deploy/handlers/generic-scoring-handler/index"
    );
    await handler();
  } finally {
    vi.useRealTimers();
  }
}

function updateCommands() {
  return ddbSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((c) => c.constructor.name === "UpdateCommand");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
  ddbSend.mockReset();
  ebSend.mockReset();
  ebSend.mockResolvedValue({ FailedEntryCount: 0 });
  process.env.DEPLOY_EVENT_BUS_NAME = "tc-deploy-bus";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.BATTLE_PROBLEMS_DISRUPTIONS = undefined;
  process.env.DEPLOY_EVENT_BUS_NAME = undefined;
});

describe("condition-triggered disruption fire", () => {
  it("should publish a disruption event and persist firedDisruptions when score crosses the threshold", async () => {
    configureScoringAndDisruptions();
    mockDdb();
    await runHandler();

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putCmd = ebSend.mock.calls[0][0] as {
      input: { Entries: Array<{ DetailType: string; EventBusName: string; Detail: string }> };
    };
    const entry = putCmd.input.Entries[0];
    expect(entry.DetailType).toBe("DegradedDisruptionFired");
    expect(entry.EventBusName).toBe("tc-deploy-bus");
    const detail = JSON.parse(entry.Detail);
    expect(detail).toMatchObject({
      disruptionId: "latency",
      teamId: "team-1",
      problemId: "hello-world-battle",
      parameters: { delayMs: 200 },
      requestId: "JOB-1#latency",
      triggeredBy: "team-score-above",
    });

    // 2nd UpdateCommand persists firedDisruptions (1st = score).
    const updates = updateCommands();
    expect(updates.length).toBe(2);
    const state = JSON.parse(
      (updates[1].input.ExpressionAttributeValues as Record<string, string>)[":state"],
    );
    expect(state.firedDisruptions).toEqual(["latency"]);
  });

  it("should not re-fire a disruption already recorded in firedDisruptions (idempotency)", async () => {
    configureScoringAndDisruptions();
    mockDdb({ scoringState: JSON.stringify({ firedDisruptions: ["latency"] }) });
    await runHandler();
    expect(ebSend).not.toHaveBeenCalled();
    expect(updateCommands().length).toBe(1); // score only, no fired-persist
  });

  it("should not fire when the event bus is unwired", async () => {
    configureScoringAndDisruptions();
    process.env.DEPLOY_EVENT_BUS_NAME = "";
    mockDdb();
    await runHandler();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it("should not persist firedDisruptions when publish reports a failed entry", async () => {
    configureScoringAndDisruptions();
    ebSend.mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: "Throttled" }] });
    mockDdb();
    await runHandler();
    expect(ebSend).toHaveBeenCalledTimes(1);
    // publish 失敗 → 2nd UpdateCommand (firedDisruptions) は走らない (score の 1 件のみ)。
    expect(updateCommands().length).toBe(1);
  });
});
