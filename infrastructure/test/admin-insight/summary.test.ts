import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeTenants } from "../../lib/admin-insight/handlers/admin-insight-handler/summary";

function buildShared(send: ReturnType<typeof vi.fn>) {
  return {
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
  };
}

describe("summarizeTenants", () => {
  beforeEach(() => vi.clearAllMocks());

  it("single tenant: should correctly aggregate active/failed deploy + total events", async () => {
    const send = vi.fn().mockImplementation(async (cmd: QueryCommand) => {
      const tableName = cmd.input.TableName;
      if (tableName === "TestDeployments") {
        return {
          Items: [
            { status: "PENDING" },
            { status: "IN_PROGRESS" },
            { status: "IN_PROGRESS" },
            { status: "FAILED" },
            { status: "COMPLETE" }, // active / failed どちらでもないので counter には入らない
            { status: "DELETED" },
          ],
        };
      }
      if (tableName === "TestEvents") {
        return { Count: 7 };
      }
      throw new Error(`unexpected table: ${tableName}`);
    });
    const shared = buildShared(send);
    const result = await summarizeTenants(shared, ["tenant-a"]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      tenantId: "tenant-a",
      activeDeploys: 3, // PENDING + IN_PROGRESS × 2
      failedDeploys: 1,
      totalEvents: 7,
    });
  });

  it("should query duplicate tenantIds only once", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [], Count: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-a", "tenant-a", "tenant-a"]);
    // 1 tenant あたり Deployments query + Events query = 2 invocation。
    // 重複除去が効いていれば 2 回しか送らない。
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("should preserve input order (after dedupe) in results", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [], Count: 0 });
    const shared = buildShared(send);
    const result = await summarizeTenants(shared, ["tenant-c", "tenant-a", "tenant-b"]);
    expect(result.items.map((i) => i.tenantId)).toEqual(["tenant-c", "tenant-a", "tenant-b"]);
  });

  it("should return empty items for empty tenantIds (no DDB call)", async () => {
    const send = vi.fn();
    const shared = buildShared(send);
    const result = await summarizeTenants(shared, []);
    expect(result.items).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("should aggregate across all pages when LastEvaluatedKey indicates more pages", async () => {
    let deployCall = 0;
    const send = vi.fn().mockImplementation(async (cmd: QueryCommand) => {
      const tableName = cmd.input.TableName;
      if (tableName === "TestDeployments") {
        deployCall += 1;
        if (deployCall === 1) {
          return {
            Items: [{ status: "PENDING" }, { status: "FAILED" }],
            LastEvaluatedKey: { PK: "DEPLOYMENT#x" },
          };
        }
        return { Items: [{ status: "IN_PROGRESS" }] };
      }
      return { Count: 0 };
    });
    const shared = buildShared(send);
    const result = await summarizeTenants(shared, ["tenant-a"]);
    expect(result.items[0]).toMatchObject({
      tenantId: "tenant-a",
      activeDeploys: 2, // PENDING + IN_PROGRESS
      failedDeploys: 1,
    });
  });

  it("Deployments query should use GSI1 + TENANT#<id> partition key", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [], Count: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-acme"]);
    const deployQuery = send.mock.calls
      .map((call) => call[0] as QueryCommand)
      .find((cmd) => cmd.input.TableName === "TestDeployments");
    expect(deployQuery).toBeDefined();
    expect(deployQuery?.input.IndexName).toBe("GSI1");
    expect(deployQuery?.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
  });

  it("Events query should minimize payload via Select=COUNT", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [], Count: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-acme"]);
    const eventsQuery = send.mock.calls
      .map((call) => call[0] as QueryCommand)
      .find((cmd) => cmd.input.TableName === "TestEvents");
    expect(eventsQuery).toBeDefined();
    expect(eventsQuery?.input.Select).toBe("COUNT");
  });
});
