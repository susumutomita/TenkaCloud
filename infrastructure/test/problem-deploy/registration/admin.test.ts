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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
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

  it("allows a viewer to inspect the public summary without exposing saved claim secrets", async () => {
    const f = await fixture();
    await f.sql.run(
      "UPDATE events SET payload = json_set(payload, '$.registration.claims', json(?))",
      [
        JSON.stringify([
          {
            teamId: `${fixtureEventId.slice(0, -1)}1`,
            receiptHash: "private-receipt-hash",
            claimedAt: new Date().toISOString(),
          },
        ]),
      ],
    );
    vi.stubEnv("DEFAULT_USER_ROLE", "TenantViewer");
    vi.stubEnv("DEFAULT_TENANT_SUSPENDED", "true");
    const response = await f.app.request(path);
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({
      claimed: 1,
      claimedTeamIds: [`${fixtureEventId.slice(0, -1)}1`],
    });
    expect(JSON.stringify(summary)).not.toMatch(/invitation|receipt|Hash/);
    expect((await f.app.request(path, close)).status).toBe(403);
  });

  it.each(["TenantMachine", "TenantUser", ""])("rejects %s on summary reads", async (role) => {
    const f = await fixture();
    vi.stubEnv("DEFAULT_USER_ROLE", role);
    const response = await f.app.request(path);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role" });
  });

  it("fails closed when the tenant identity is absent", async () => {
    const f = await fixture();
    const original = await f.deps.events.getEvent(fixtureTenantId, fixtureEventId);
    const update = vi.spyOn(f.deps.events, "updateRegistration");
    vi.stubEnv("DEFAULT_TENANT_ID", "");
    for (const options of [undefined, close]) {
      const response = await f.app.request(path, options);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "missing_tenant_claim" });
      expect(await f.deps.events.getEvent(fixtureTenantId, fixtureEventId)).toEqual(original);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["", "{"])("rejects malformed admin JSON %s", async (body) => {
    const f = await fixture();
    const response = await f.app.request(path, { ...close, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
    expect(
      (await f.deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.enabled,
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { enabled: false, teamIds: [] },
    { enabled: "false" },
    { enabled: true, teamIds: [fixtureEventId], closesAt: "not-a-date" },
    { enabled: true, teamIds: ["not-an-id"], closesAt: "2030-01-01T00:00:00.000Z" },
    {
      enabled: true,
      teamIds: Array.from({ length: 100 }, () => fixtureEventId),
      closesAt: "2030-01-01T00:00:00.000Z",
    },
    {
      enabled: true,
      teamIds: [fixtureEventId],
      closesAt: "2030-01-01T00:00:00.000Z",
      invitation: "chosen-by-client",
    },
  ])("rejects invalid admin settings %j before accessing repositories", async (body) => {
    const f = await fixture();
    const resolve = vi.spyOn(f.shared.runtime, "resolveRepositories");
    const response = await f.app.request(path, { ...close, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "validation_failed",
      issues: expect.any(Array),
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects invalid event IDs on both read and update routes", async () => {
    const f = await fixture();
    const resolve = vi.spyOn(f.shared.runtime, "resolveRepositories");
    for (const options of [undefined, close]) {
      const response = await f.app.request("/events/invalid/registration", options);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_event_id" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "closed",
    "invalid_pool",
    "not_ready",
    "login_key_missing",
    "conflict",
  ] as const)("returns the business error %s without changing registration settings", async (code) => {
    const f = await fixture();
    const event = await f.deps.events.getEvent(fixtureTenantId, fixtureEventId);
    if (!event?.registration) throw new Error("fixture registration missing");
    let teamIds = event.registration.teamIds;
    if (code === "closed") {
      await f.deps.events.putEvent({ ...event, expiresAt: 1 });
    } else if (code === "invalid_pool") {
      teamIds = [teamIds[0], teamIds[0]];
    } else if (code === "not_ready") {
      await f.sql.run("DELETE FROM deployments");
    } else if (code === "login_key_missing") {
      await f.sql.run("UPDATE teams SET payload = json_remove(payload, '$.teamLoginKey')");
    } else {
      await f.sql.run(
        "CREATE TRIGGER reject_registration BEFORE UPDATE ON events BEGIN SELECT RAISE(IGNORE); END",
      );
    }
    const response = await f.app.request(path, {
      ...close,
      body: JSON.stringify({ enabled: true, teamIds, closesAt: event.registration.closesAt }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
    expect((await f.deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration).toEqual(
      event.registration,
    );
  });

  it("returns not_found for a deleted event on both read and update routes", async () => {
    const f = await fixture();
    await f.deps.events.deleteEvent(fixtureEventId);
    for (const options of [undefined, close]) {
      const response = await f.app.request(path, options);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("returns internal_error for a real storage failure without exposing SQL details", async () => {
    const f = await fixture();
    await f.sql.run("DROP TABLE events");
    const errors = vi.spyOn(console, "error");
    const response = await f.app.request(path, close);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(errors).toHaveBeenCalledWith("[registration] configuration failed", {
      eventId: fixtureEventId,
      message: expect.stringContaining("no such table: events"),
    });
  });
});
