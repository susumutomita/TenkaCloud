import { describe, expect, it, vi } from "vitest";
import { getCapacityOverview, startCapacityScale } from "../../src/api/capacity-client";
import type { ApiClient } from "../../src/api/client";

/** Issue #2410 Slice 2: GET /admin/capacity client. Issue #2680: POST /admin/capacity client. */

function clientWith(get: ReturnType<typeof vi.fn>): ApiClient {
  return { get } as unknown as ApiClient;
}

describe("getCapacityOverview", () => {
  it("should GET /admin/capacity without a query when windowMinutes is omitted", async () => {
    const get = vi.fn().mockResolvedValue({ windowMinutes: 30, tables: [] });

    const overview = await getCapacityOverview(clientWith(get));

    expect(get).toHaveBeenCalledWith("/admin/capacity");
    expect(overview).toEqual({ windowMinutes: 30, tables: [] });
  });

  it("should pass windowMinutes through as a query parameter", async () => {
    const get = vi.fn().mockResolvedValue({ windowMinutes: 60, tables: [] });

    await getCapacityOverview(clientWith(get), 60);

    expect(get).toHaveBeenCalledWith("/admin/capacity?windowMinutes=60");
  });
});

describe("startCapacityScale", () => {
  it("should POST the scale request to /admin/capacity and return the accepted payload", async () => {
    const accepted = {
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
      status: "accepted",
    };
    const post = vi.fn().mockResolvedValue(accepted);

    const result = await startCapacityScale({ post } as unknown as ApiClient, {
      tableName: "Deployments-x",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
    });

    expect(post).toHaveBeenCalledWith("/admin/capacity", {
      tableName: "Deployments-x",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
    });
    expect(result).toEqual(accepted);
  });
});
