import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  listEndpoints,
  registerEndpoint,
} from "../../lib/problem-deploy/handlers/microservice-migration-registration-handler/store";

const buildShared = () => {
  const send = vi.fn().mockResolvedValue({});
  return {
    send,
    shared: {
      tableName: "TestMicroserviceMigrationScores",
      ddb: { send } as unknown as Parameters<typeof registerEndpoint>[0]["ddb"],
    },
  };
};

describe("registerEndpoint", () => {
  it("PK = TENANT#... + SK = SLOT#users で UpdateCommand を発行すべき", async () => {
    const { send, shared } = buildShared();
    await registerEndpoint(
      shared,
      { tenantId: "tenant-A", nowMs: Date.parse("2026-05-12T10:00:00.000Z"), registeredBy: "u1" },
      { slot: "users", url: "https://users.example.com" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.Key).toEqual({
      PK: "TENANT#tenant-A#PROBLEM#microservice-migration-battle",
      SK: "SLOT#users",
    });
  });

  it("UpdateExpression は observation 系 (platform / lastProbeAt 等) を触らないべき", async () => {
    const { send, shared } = buildShared();
    await registerEndpoint(
      shared,
      { tenantId: "t", nowMs: Date.parse("2026-05-12T10:00:00.000Z"), registeredBy: "u1" },
      { slot: "orders", url: "https://orders.example.com" },
    );
    const cmd = send.mock.calls[0]?.[0] as UpdateCommand;
    const expr = cmd.input.UpdateExpression ?? "";
    expect(expr).toContain("registeredUrl");
    expect(expr).toContain("registeredAt");
    // observation 系は polling Lambda 専管 (= UpdateExpression に出てきてはいけない)
    expect(expr).not.toContain("platform");
    expect(expr).not.toContain("lastProbeAt");
    expect(expr).not.toContain("lastResult");
    expect(expr).not.toContain("fullMigrationBonusAwarded");
  });

  it("response に slot / registeredUrl / registeredAt を返すべき", async () => {
    const { shared } = buildShared();
    const res = await registerEndpoint(
      shared,
      { tenantId: "t", nowMs: Date.parse("2026-05-12T10:00:00.000Z"), registeredBy: "u1" },
      { slot: "catalog", url: "https://catalog.example.com" },
    );
    expect(res).toEqual({
      slot: "catalog",
      registeredUrl: "https://catalog.example.com",
      registeredAt: "2026-05-12T10:00:00.000Z",
    });
  });
});

describe("listEndpoints", () => {
  it("QueryCommand で PK 単位で取得すべき", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] });
    const shared = {
      tableName: "TestMicroserviceMigrationScores",
      ddb: { send } as unknown as Parameters<typeof listEndpoints>[0]["ddb"],
    };
    await listEndpoints(shared, "tenant-A");
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#tenant-A#PROBLEM#microservice-migration-battle",
    });
  });

  it("DDB 行を summary 形 (slot / registeredUrl / 等) に整形して返すべき", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          slot: "users",
          registeredUrl: "https://users.example.com",
          registeredAt: "2026-05-12T10:00:00.000Z",
          platform: "lambda",
          lastResult: "ok",
          lastProbeAt: "2026-05-12T10:01:00.000Z",
          lastPoints: 1_000,
          lastResponseTimeMs: 42,
        },
      ],
    });
    const shared = {
      tableName: "T",
      ddb: { send } as unknown as Parameters<typeof listEndpoints>[0]["ddb"],
    };
    const out = await listEndpoints(shared, "t");
    expect(out.items).toEqual([
      {
        slot: "users",
        registeredUrl: "https://users.example.com",
        registeredAt: "2026-05-12T10:00:00.000Z",
        platform: "lambda",
        lastResult: "ok",
        lastProbeAt: "2026-05-12T10:01:00.000Z",
        lastPoints: 1_000,
        lastResponseTimeMs: 42,
      },
    ]);
  });

  it("不完全な行 (= slot / registeredUrl 欠落) は除外すべき", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        { slot: "users", registeredAt: "2026-05-12T10:00:00.000Z" }, // registeredUrl 無し
      ],
    });
    const shared = {
      tableName: "T",
      ddb: { send } as unknown as Parameters<typeof listEndpoints>[0]["ddb"],
    };
    const out = await listEndpoints(shared, "t");
    expect(out.items).toEqual([]);
  });
});
