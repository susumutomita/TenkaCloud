import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: event-handler の Hono app (index.ts) の wiring 層 (cors / onError 3 枝 /
 * /events/* role middleware / healthz) を pin する。 routes/* は各 route test で 100% だが、
 * この index.ts の onError MissingTenantClaim 枝と healthz-skip 枝が未カバーで 62% branch だった。
 *
 * onError の 3 枝は try/catch を経由しない top-level throwing route で踏む
 * (handler-error-cors.test.ts と同手法。 `/events/*` 配下に置くと `/events/:eventId` と衝突して
 * 400 になるため top-level に置く)。 ForbiddenRole + middleware は実 `/events/:eventId` 経路で踏む。
 * buildEventSharedResources のみ mock。
 */
vi.mock("../../lib/problem-deploy/handlers/event-handler/shared", () => ({
  buildEventSharedResources: () => ({
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: vi.fn() },
    events: { send: vi.fn() },
    problemsCatalog: {},
  }),
  queryDeploymentsByEvent: vi.fn(),
}));

const { app } = await import("../../lib/problem-deploy/handlers/event-handler/index");
const { MissingTenantClaimError } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/auth"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// top-level (= /events/* 外) の throwing route。 middleware を介さず onError に直接到達する。
app.get("/__throw_missing_tenant__", () => {
  throw new MissingTenantClaimError();
});
app.get("/__throw_generic__", () => {
  throw new Error("boom");
});

beforeEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  delete process.env.DEFAULT_TENANT_SUSPENDED;
});
afterEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  delete process.env.DEFAULT_TENANT_SUSPENDED;
});

describe("event-handler app wiring", () => {
  it("should allow PUT in CORS preflight for Progression Gate writes", async () => {
    const res = await app.request(`/events/${EVENT_ID}/progression-gate`, {
      method: "OPTIONS",
      headers: {
        origin: "https://admin.example.com",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("should serve /events/healthz, skipping the role middleware", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser"; // would 403 if the middleware did not skip
    const res = await app.request("/events/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("should map MissingTenantClaimError to 401 via onError (with CORS)", async () => {
    const res = await app.request("/__throw_missing_tenant__");
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect((await res.json()).error).toBe("missing_tenant_claim");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("should map an uncaught throw to 500 + CORS via onError", async () => {
    const res = await app.request("/__throw_generic__");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("internal_error");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("should 403 forbidden_role via the /events/* middleware on a non-tenant role", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser"; // not in TENANT_ROLES
    const res = await app.request(`/events/${EVENT_ID}`);
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_role");
  });

  it("should 403 tenant_suspended before creating a new event", async () => {
    process.env.DEFAULT_TENANT_SUSPENDED = "true";
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Spring Cup",
        teams: [{ internalSlug: "team-a", awsAccountId: "123456789012" }],
        problems: [{ problemId: "p-1", defaultRegion: "ap-northeast-1" }],
      }),
    });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("tenant_suspended");
  });

  it("should 403 tenant_suspended before bulk-deploying an event", async () => {
    process.env.DEFAULT_TENANT_SUSPENDED = "true";
    const res = await app.request(`/events/${EVENT_ID}/deploy`, { method: "POST" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("tenant_suspended");
  });
});
