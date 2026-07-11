import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeTenants } from "../../lib/admin-insight/handlers/admin-insight-handler/summary";
import { makeTestControlDataRuntime } from "../problem-deploy/control-data/runtime.test-helpers";

function buildShared(send: ReturnType<typeof vi.fn>) {
  return {
    runtime: makeTestControlDataRuntime(),
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
  };
}

/**
 * [Issue #2441 / Phase B PR-6] `countTenantDeployments` now delegates to the
 * `DeploymentsRepository.countActiveByTenant` seam instead of a raw single Query
 * that read full items and counted status client-side. The repository issues TWO
 * `Select=COUNT` + `FilterExpression: "#s IN (...)"` queries against Deployments
 * (one for the active statuses, one for FAILED) — distinguishable from the
 * Events count query (no `FilterExpression`, see `countEventsByTenant`) by
 * `cmd.input.FilterExpression` presence, and from each other by which status
 * value the filter's `ExpressionAttributeValues` carries.
 */
function mockDeploymentsAndEventsCounts(counts: {
  readonly active: number;
  readonly failed: number;
  readonly events: number;
}): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (cmd: QueryCommand) => {
    const tableName = cmd.input.TableName;
    if (tableName === "TestEvents") return { Count: counts.events };
    if (tableName === "TestDeployments") {
      const values = Object.values(cmd.input.ExpressionAttributeValues ?? {});
      if (values.includes("FAILED")) return { Count: counts.failed };
      return { Count: counts.active };
    }
    throw new Error(`unexpected table: ${tableName}`);
  });
}

describe("summarizeTenants", () => {
  beforeEach(() => vi.clearAllMocks());

  it("single tenant: should correctly aggregate active/failed deploy + total events", async () => {
    const send = mockDeploymentsAndEventsCounts({ active: 3, failed: 1, events: 7 });
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
    const send = mockDeploymentsAndEventsCounts({ active: 0, failed: 0, events: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-a", "tenant-a", "tenant-a"]);
    // 1 tenant あたり Deployments (active + failed の 2 query) + Events query = 3 invocation。
    // 重複除去が効いていれば 3 回しか送らない。
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("should preserve input order (after dedupe) in results", async () => {
    const send = mockDeploymentsAndEventsCounts({ active: 0, failed: 0, events: 0 });
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
    let activeCall = 0;
    const send = vi.fn().mockImplementation(async (cmd: QueryCommand) => {
      const tableName = cmd.input.TableName;
      if (tableName !== "TestDeployments") return { Count: 0 };
      const values = Object.values(cmd.input.ExpressionAttributeValues ?? {});
      if (values.includes("FAILED")) return { Count: 1 };
      activeCall += 1;
      if (activeCall === 1) {
        return { Count: 1, LastEvaluatedKey: { PK: "DEPLOYMENT#x" } };
      }
      return { Count: 1 };
    });
    const shared = buildShared(send);
    const result = await summarizeTenants(shared, ["tenant-a"]);
    expect(result.items[0]).toMatchObject({
      tenantId: "tenant-a",
      activeDeploys: 2, // 2 pages, 1 each
      failedDeploys: 1,
    });
  });

  it("Deployments query should use GSI1 + TENANT#<id> partition key", async () => {
    const send = mockDeploymentsAndEventsCounts({ active: 0, failed: 0, events: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-acme"]);
    const deployQuery = send.mock.calls
      .map((call) => call[0] as QueryCommand)
      .find((cmd) => cmd.input.TableName === "TestDeployments");
    expect(deployQuery).toBeDefined();
    expect(deployQuery?.input.IndexName).toBe("GSI1");
    expect(deployQuery?.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
  });

  it("Deployments/Events queries should minimize payload via Select=COUNT", async () => {
    const send = mockDeploymentsAndEventsCounts({ active: 0, failed: 0, events: 0 });
    const shared = buildShared(send);
    await summarizeTenants(shared, ["tenant-acme"]);
    for (const cmd of send.mock.calls.map((call) => call[0] as QueryCommand)) {
      expect(cmd.input.Select).toBe("COUNT");
    }
  });
});
