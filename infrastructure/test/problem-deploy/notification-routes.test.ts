import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: operator→competitor notification route (routes/notifications.ts)。
 * POST /events/:eventId/notifications の body-validation / not_found / created / error 分岐。
 */
const mocks = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/create-notification", () => ({
  createNotification: mocks.createNotification,
}));

const { registerNotificationRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/notifications"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared。
const shared = { ddb: { send: vi.fn() } } as any;
const post = (body: unknown) => {
  const app = new Hono();
  registerNotificationRoutes(app, shared);
  return app.request(`/events/${EVENT_ID}/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};
const validBody = { title: "Heads up", body: "The arena resets in 5 minutes." };

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("POST /events/:eventId/notifications", () => {
  it("should 400 on an invalid body", async () => {
    const res = await post({ title: "" }); // empty title + missing body
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("should 404 when the event is not found", async () => {
    mocks.createNotification.mockResolvedValueOnce({ kind: "not_found" });
    expect((await post(validBody)).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 201 with notificationId + occurredAt on success", async () => {
    mocks.createNotification.mockResolvedValueOnce({
      kind: "ok",
      notificationId: "ntf-1",
      occurredAt: "2026-06-01T00:00:00.000Z",
    });
    const res = await post(validBody);
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(await res.json()).toEqual({
      notificationId: "ntf-1",
      occurredAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("should surface a createNotification error (5xx)", async () => {
    mocks.createNotification.mockRejectedValueOnce(new Error("boom"));
    expect((await post(validBody)).status).toBeGreaterThanOrEqual(500);
  });
});
