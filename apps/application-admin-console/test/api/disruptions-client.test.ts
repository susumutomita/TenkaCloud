import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  cancelRecurringDisruption,
  fetchActiveRecurring,
  fetchDisruptionAudit,
  fetchDisruptionCatalog,
  fireDisruption,
  newFireRequestId,
} from "../../src/api/disruptions-client";

/** [#1417/#1666] disruptions API client — path/body construction + query encoding. */
function fakeApi(): ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue({ entries: [], items: [] }),
    post: vi.fn().mockResolvedValue({ auditId: "a1", firedAt: "t", affectedTeamIds: ["x"] }),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}

describe("disruptions-client", () => {
  it("should GET the catalog at the event path", async () => {
    const api = fakeApi();
    await fetchDisruptionCatalog(api, "EVT1");
    expect(api.get).toHaveBeenCalledWith("events/EVT1/disruptions");
  });

  it("should POST the fire request and return the result", async () => {
    const api = fakeApi();
    const result = await fireDisruption(api, "EVT1", {
      problemId: "p",
      disruptionId: "d",
      scope: "all",
      requestId: "fire-abcdef12",
    });
    expect(api.post).toHaveBeenCalledWith("events/EVT1/disruptions/fire", {
      problemId: "p",
      disruptionId: "d",
      scope: "all",
      requestId: "fire-abcdef12",
    });
    expect(result.affectedTeamIds).toEqual(["x"]);
  });

  it("should GET audit with no query when no options", async () => {
    const api = fakeApi();
    await fetchDisruptionAudit(api, "EVT1");
    expect(api.get).toHaveBeenCalledWith("events/EVT1/disruptions/audit");
  });

  it("should GET audit with limit + cursor query params", async () => {
    const api = fakeApi();
    await fetchDisruptionAudit(api, "EVT1", { limit: 20, cursor: "c1" });
    expect(api.get).toHaveBeenCalledWith("events/EVT1/disruptions/audit?limit=20&cursor=c1");
  });

  it("should mint a request id of at least 8 chars", () => {
    expect(newFireRequestId().length).toBeGreaterThanOrEqual(8);
    expect(newFireRequestId()).not.toBe(newFireRequestId());
  });

  it("should GET the active recurring list at the event path", async () => {
    const api = fakeApi();
    await fetchActiveRecurring(api, "EVT1");
    expect(api.get).toHaveBeenCalledWith("events/EVT1/disruptions/recurring");
  });

  it("should POST the recurring cancel at the request path", async () => {
    const api = fakeApi();
    await cancelRecurringDisruption(api, "EVT1", "r1");
    expect(api.post).toHaveBeenCalledWith("events/EVT1/disruptions/recurring/r1/cancel", {});
  });
});
