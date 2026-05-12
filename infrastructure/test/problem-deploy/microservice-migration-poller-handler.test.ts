import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Microservice Migration Battle (Phase 2 / #606) polling Lambda の handler() レベル test。
 *
 * fetch は probe.ts のヘルパー (fetchPlatform / probeScore) 経由でしか呼ばれないので
 * そこを `vi.mock` で差し替える。DDB は `@aws-sdk/lib-dynamodb` の Document client の
 * `send` を mock して 1 invocation 中の全 command を観察する。
 */

const probeMocks = vi.hoisted(() => ({
  fetchPlatform: vi.fn(),
  probeScore: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/microservice-migration-poller-handler/probe", () => ({
  fetchPlatform: probeMocks.fetchPlatform,
  probeScore: probeMocks.probeScore,
}));

const sendMock = vi.fn();
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({ send: sendMock }),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MICROSERVICE_MIGRATION_SCORES_TABLE_NAME = "TestScores";
  process.env.DEPLOYMENTS_TABLE_NAME = "TestDeployments";
  process.env.MICROSERVICE_MIGRATION_DEGRADATION_MINUTES = "60";
  process.env.MICROSERVICE_MIGRATION_LEGACY_SWITCH_MINUTES = "90";
});

afterEach(() => {
  delete process.env.MICROSERVICE_MIGRATION_SCORES_TABLE_NAME;
  delete process.env.DEPLOYMENTS_TABLE_NAME;
});

const { handler } = await import(
  "../../lib/problem-deploy/handlers/microservice-migration-poller-handler/index"
);

function buildSlotRow(
  tenantId: string,
  slot: string,
  url: string,
  extra: Record<string, unknown> = {},
) {
  return {
    PK: `TENANT#${tenantId}#PROBLEM#microservice-migration-battle`,
    SK: `SLOT#${slot}`,
    tenantId,
    slot,
    registeredUrl: url,
    ...extra,
  };
}

function buildDeploymentRow(tenantId: string, createdAt: string) {
  return {
    PK: "DEPLOYMENT#JOB1",
    SK: "META",
    GSI1PK: `TENANT#${tenantId}`,
    GSI1SK: createdAt,
    jobId: "JOB1",
    problemId: "microservice-migration-battle",
    tenantId,
    teamId: "T1",
    eventId: "E1",
    expiresAt: 1_900_000_000,
    createdAt,
    status: "COMPLETE",
  };
}

describe("handler() (microservice-migration poller, #606)", () => {
  it("登録 0 件なら DDB に Scan しか発行しないべき", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }); // Scan
    await handler();
    // Scan 1 回のみ
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
  });

  it("registered slot 1 件: probe → ScoreEvent / observation 更新を発行すべき", async () => {
    const createdAt = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min 前 (pre-degradation)

    sendMock.mockResolvedValueOnce({
      Items: [buildSlotRow("tA", "users", "https://x.example.com")],
    }); // Scan
    sendMock.mockResolvedValueOnce({
      Items: [buildDeploymentRow("tA", createdAt)],
    }); // findTenantDeployment Query
    sendMock.mockResolvedValueOnce({}); // updateSlotObservation
    sendMock.mockResolvedValueOnce({}); // writeScoreEvent Put

    probeMocks.fetchPlatform.mockResolvedValueOnce("lambda");
    probeMocks.probeScore.mockResolvedValueOnce({
      ok: true,
      status: 200,
      responseTimeMs: 100,
    });

    await handler();

    // probe.ts が 1 slot ぶん 1 回ずつ呼ばれる
    expect(probeMocks.fetchPlatform).toHaveBeenCalledWith("https://x.example.com");
    expect(probeMocks.probeScore).toHaveBeenCalledWith("https://x.example.com", "/score");

    // updateSlotObservation の UpdateCommand に platform=lambda / points=1000 が入る
    const updateCalls = sendMock.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand);
    const obsUpdate = updateCalls.find(
      (cmd) =>
        typeof cmd.input.UpdateExpression === "string" &&
        cmd.input.UpdateExpression.includes("platform"),
    );
    expect(obsUpdate).toBeDefined();
    expect(obsUpdate?.input.ExpressionAttributeValues?.[":platform"]).toBe("lambda");
    expect(obsUpdate?.input.ExpressionAttributeValues?.[":points"]).toBe(1_000);
    expect(obsUpdate?.input.ExpressionAttributeValues?.[":result"]).toBe("ok");
  });

  it("3 slot 全 non-ec2 達成時に +5000 lump-sum bonus を 1 度発行すべき", async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    sendMock.mockResolvedValueOnce({
      Items: [
        buildSlotRow("tA", "users", "https://u.example.com"),
        buildSlotRow("tA", "orders", "https://o.example.com"),
        buildSlotRow("tA", "catalog", "https://c.example.com"),
      ],
    });
    sendMock.mockResolvedValueOnce({ Items: [buildDeploymentRow("tA", createdAt)] });
    // 3 slot 並列処理: updateSlotObservation × 3 + writeScoreEvent × 3 の任意順
    // → 残り全 send は {} で OK
    sendMock.mockResolvedValue({});

    probeMocks.fetchPlatform.mockResolvedValue("lambda");
    probeMocks.probeScore.mockResolvedValue({
      ok: true,
      status: 200,
      responseTimeMs: 50,
    });

    await handler();

    // ConditionExpression 付き UpdateCommand (fullMigrationBonusAwarded sentinel) が
    // 1 回呼ばれているはず
    const bonusUpdate = sendMock.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand)
      .find(
        (cmd) =>
          typeof cmd.input.UpdateExpression === "string" &&
          cmd.input.UpdateExpression.includes("fullMigrationBonusAwarded"),
      );
    expect(bonusUpdate).toBeDefined();
    expect(bonusUpdate?.input.ConditionExpression).toContain("fullMigrationBonusAwarded");
  });

  it("既に fullMigrationBonusAwarded=true なら bonus sentinel を発行しないべき (= 二重発行防止)", async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    sendMock.mockResolvedValueOnce({
      Items: [
        buildSlotRow("tA", "users", "https://u.example.com", { fullMigrationBonusAwarded: true }),
        buildSlotRow("tA", "orders", "https://o.example.com"),
        buildSlotRow("tA", "catalog", "https://c.example.com"),
      ],
    });
    sendMock.mockResolvedValueOnce({ Items: [buildDeploymentRow("tA", createdAt)] });
    sendMock.mockResolvedValue({});
    probeMocks.fetchPlatform.mockResolvedValue("lambda");
    probeMocks.probeScore.mockResolvedValue({
      ok: true,
      status: 200,
      responseTimeMs: 50,
    });

    await handler();

    // ConditionExpression 付き sentinel UpdateCommand が 0 件であることを確認
    const bonusUpdates = sendMock.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand)
      .filter(
        (cmd) =>
          typeof cmd.input.UpdateExpression === "string" &&
          cmd.input.UpdateExpression.includes("fullMigrationBonusAwarded"),
      );
    expect(bonusUpdates).toHaveLength(0);
  });

  it("90 分経過後は /score?legacy=true を probe すべき", async () => {
    const createdAt = new Date(Date.now() - 100 * 60_000).toISOString(); // 100 min 前
    sendMock.mockResolvedValueOnce({
      Items: [buildSlotRow("tA", "users", "https://x.example.com")],
    });
    sendMock.mockResolvedValueOnce({ Items: [buildDeploymentRow("tA", createdAt)] });
    sendMock.mockResolvedValue({});

    probeMocks.fetchPlatform.mockResolvedValueOnce("lambda");
    probeMocks.probeScore.mockResolvedValueOnce({
      ok: true,
      status: 200,
      responseTimeMs: 50,
    });

    await handler();

    expect(probeMocks.probeScore).toHaveBeenCalledWith(
      "https://x.example.com",
      "/score?legacy=true",
    );
  });

  it("probe 失敗時は lastResult=fail / points=-100 で記録すべき", async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    sendMock.mockResolvedValueOnce({
      Items: [buildSlotRow("tA", "users", "https://x.example.com")],
    });
    sendMock.mockResolvedValueOnce({ Items: [buildDeploymentRow("tA", createdAt)] });
    sendMock.mockResolvedValue({});

    probeMocks.fetchPlatform.mockResolvedValueOnce(undefined);
    probeMocks.probeScore.mockResolvedValueOnce({
      ok: false,
      status: 500,
      responseTimeMs: 100,
      reason: "non-2xx",
    });

    await handler();

    const obsUpdate = sendMock.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand)
      .find(
        (cmd) =>
          typeof cmd.input.UpdateExpression === "string" &&
          cmd.input.UpdateExpression.includes("platform"),
      );
    expect(obsUpdate?.input.ExpressionAttributeValues?.[":result"]).toBe("fail");
    expect(obsUpdate?.input.ExpressionAttributeValues?.[":points"]).toBe(-100);
  });
});
