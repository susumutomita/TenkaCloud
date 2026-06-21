import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { createDemoApiClient, demoRouteKey } from "./demo-client";
import type { EventListResponse } from "./events-client";

describe("demoRouteKey", () => {
  it("should strip a leading slash and the query string", () => {
    expect(demoRouteKey("events")).toBe("events");
    expect(demoRouteKey("/events")).toBe("events");
    expect(demoRouteKey("events?limit=50&cursor=abc")).toBe("events");
    expect(demoRouteKey("/deployments/j-1/stack-progress")).toBe("deployments/j-1/stack-progress");
  });
});

describe("createDemoApiClient", () => {
  const client = createDemoApiClient();

  it("should return simulated events for GET events (with and without query)", async () => {
    const res = await client.get<EventListResponse>("events");
    expect(res.items).toHaveLength(3);
    expect(res.items.map((e) => e.eventId)).toEqual([
      "demo-event-ready",
      "demo-event-deploying",
      "demo-event-ended",
    ]);
    const withQuery = await client.get<EventListResponse>("events?limit=50");
    expect(withQuery.items).toHaveLength(3);
  });

  it("should throw ApiError(NOT_IMPLEMENTED) for an unsupported GET path", async () => {
    await expect(client.get("deployments/j-1")).rejects.toBeInstanceOf(ApiError);
    await expect(client.get("deployments/j-1")).rejects.toThrow(/Demo mode does not simulate/);
  });

  it("should throw ApiError for every mutating method (no real AWS is called)", async () => {
    await expect(client.post("events", {})).rejects.toBeInstanceOf(ApiError);
    await expect(client.put("events/e-1", {})).rejects.toBeInstanceOf(ApiError);
    await expect(client.patch("events/e-1", {})).rejects.toBeInstanceOf(ApiError);
    await expect(client.del("events/e-1")).rejects.toBeInstanceOf(ApiError);
    await expect(client.delJson("events/e-1")).rejects.toBeInstanceOf(ApiError);
  });
});
