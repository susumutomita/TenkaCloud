import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: bulk-deploy fan-out route (routes/bulk-deploy.ts, #555)。
 * POST /events/:eventId/deploy。 body は opt-in (空 body = bulk-all)。
 * 空 body / 不正 body / not_found / accepted / error の分岐を pin する。
 */
const mocks = vi.hoisted(() => ({ bulkDeployEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-deploy", () => ({
  bulkDeployEvent: mocks.bulkDeployEvent,
}));

const { registerBulkDeployRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/bulk-deploy"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared。
const shared = { ddb: { send: vi.fn() } } as any;
const deploy = (body?: unknown) => {
  const app = new Hono();
  registerBulkDeployRoutes(app, shared);
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return app.request(`/events/${EVENT_ID}/deploy`, init);
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("POST /events/:eventId/deploy", () => {
  it("should treat an empty body as bulk-all and 202 with the result", async () => {
    mocks.bulkDeployEvent.mockResolvedValueOnce({ kind: "ok", result: { queued: 6 } });
    const res = await deploy(); // no body
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(await res.json()).toEqual({ queued: 6 });
    // empty body → parsed.data is {} (parseOptionalJsonBody default).
    expect(mocks.bulkDeployEvent.mock.calls[0][4]).toEqual({});
  });

  it("should pass a provided filter body through to the service", async () => {
    mocks.bulkDeployEvent.mockResolvedValueOnce({ kind: "ok", result: { queued: 1 } });
    await deploy({ retryFailedOnly: true });
    expect(mocks.bulkDeployEvent.mock.calls[0][4]).toMatchObject({ retryFailedOnly: true });
  });

  it("should 400 on an invalid body", async () => {
    const res = await deploy({ retryFailedOnly: true, forceRedeploy: true }); // mutually exclusive
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.bulkDeployEvent).not.toHaveBeenCalled();
  });

  it("should 404 when the event is not found", async () => {
    mocks.bulkDeployEvent.mockResolvedValueOnce({ kind: "not_found" });
    expect((await deploy()).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should surface a bulkDeployEvent error (5xx)", async () => {
    mocks.bulkDeployEvent.mockRejectedValueOnce(new Error("boom"));
    expect((await deploy()).status).toBeGreaterThanOrEqual(500);
  });

  it("should 422 when the event cannot fit a coordination problem (#3169)", async () => {
    // Not a failed deploy: nothing was attempted, so retrying the same request
    // unchanged cannot succeed. The refusal text is what tells the operator
    // which of the two things has to change — the team count or the backend.
    mocks.bulkDeployEvent.mockResolvedValueOnce({
      kind: "capacity_exceeded",
      refusals: ['problem "ac26-crypto-battle" is forecast to need 1684251 bytes'],
    });

    const res = await deploy();

    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect(await res.json()).toEqual({
      error: "coordination_capacity_exceeded",
      refusals: ['problem "ac26-crypto-battle" is forecast to need 1684251 bytes'],
    });
  });
});
