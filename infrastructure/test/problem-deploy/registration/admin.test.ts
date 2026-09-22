import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRegistrationAdminRoutes } from "../../../lib/problem-deploy/handlers/event-handler/routes/registration";
import type { EventSharedResources } from "../../../lib/problem-deploy/handlers/event-handler/shared";
import { buildAuthErrorHandler } from "../../../lib/problem-deploy/handlers/shared/auth-wiring";
import { fixtureEventId, fixtureTenantId, registrationHttpFixture } from "./http-fixture";

async function fixture() {
  const f = await registrationHttpFixture();
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[registration-test]" }));
  registerRegistrationAdminRoutes(app, f.shared as unknown as EventSharedResources);
  vi.stubEnv("DEFAULT_TENANT_ID", fixtureTenantId);
  vi.stubEnv("DEFAULT_USER_ROLE", "TenantAdmin");
  vi.stubEnv("DEFAULT_TENANT_SUSPENDED", "false");
  return { ...f, app };
}
const path = `/events/${fixtureEventId}/registration`;
const close = {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: false }),
};
afterEach(() => vi.unstubAllEnvs());
describe("registration admin tenant and role boundaries", () => {
  it("operator closes and reissues, GET exposes no invitation or receipt hashes", async () => {
    const f = await fixture();
    vi.stubEnv("DEFAULT_USER_ROLE", "TenantOperator");
    const response = await f.app.request(path);
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({ enabled: true, capacity: 2, claimed: 0 });
    expect(JSON.stringify(summary)).not.toMatch(/invitation|receipt|Hash/);
    expect((await f.app.request(path, close)).status).toBe(200);
    const reopened = await f.app.request(path, {
      ...close,
      body: JSON.stringify({
        enabled: true,
        teamIds: summary.teamIds,
        closesAt: new Date(Date.now() + 1800000).toISOString(),
      }),
    });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      enabled: true,
      invitation: expect.stringMatching(/^[\w-]{43}$/),
    });
  });
  it("rejects viewers, machine roles and suspended tenants before mutation", async () => {
    const f = await fixture();
    for (const role of ["TenantViewer", "TenantMachine", "TenantUser"]) {
      vi.stubEnv("DEFAULT_USER_ROLE", role);
      expect((await f.app.request(path, close)).status).toBe(403);
    }
    vi.stubEnv("DEFAULT_USER_ROLE", "TenantAdmin");
    vi.stubEnv("DEFAULT_TENANT_SUSPENDED", "true");
    expect((await f.app.request(path, close)).status).toBe(403);
    expect(
      (await f.deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.enabled,
    ).toBe(true);
  });
  it("hides other tenants and rejects malformed settings", async () => {
    const f = await fixture();
    vi.stubEnv("DEFAULT_TENANT_ID", "other-tenant");
    expect((await f.app.request(path)).status).toBe(404);
    expect((await f.app.request(path, close)).status).toBe(404);
    vi.stubEnv("DEFAULT_TENANT_ID", fixtureTenantId);
    expect(
      (await f.app.request(path, { ...close, body: '{"enabled":true,"teamIds":[]}' })).status,
    ).toBe(400);
    expect((await f.app.request("/events/not-an-id/registration", close)).status).toBe(400);
  });
});
