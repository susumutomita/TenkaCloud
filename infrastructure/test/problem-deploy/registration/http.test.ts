import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPublicRegistrationRoutes } from "../../../lib/problem-deploy/handlers/participant-handler/registration";
import { configureRegistration } from "../../../lib/problem-deploy/handlers/shared/event-registration";
import { participantRateLimiter } from "../../../lib/problem-deploy/handlers/shared/rate-limiter";
import { fixtureEventId, fixtureTenantId, registrationHttpFixture } from "./http-fixture";

const base = `/portal/registration/${fixtureTenantId}/${fixtureEventId}`;
const receipt = "r".repeat(43);
const request = (token: string, body: object = {}) => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => participantRateLimiter.reset());
afterEach(() => {
  participantRateLimiter.reset();
  vi.restoreAllMocks();
});

describe("public registration API with persistent repositories", () => {
  it("registers, resumes and releases the key only after all deployments complete", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    const info = await app.request(`${base}/info`, request(invitation));
    expect(info.status).toBe(200);
    expect(info.headers.get("Cache-Control")).toContain("no-store");
    expect(await info.json()).toMatchObject({ state: "open", remaining: 2 });
    const reserved = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(reserved.status).toBe(200);
    const progress = await reserved.json();
    expect(progress).toMatchObject({ state: "preparing", ready: 0 });
    expect(progress).not.toHaveProperty("teamLoginKey");
    expect(await (await app.request(`${base}/status`, request(receipt))).json()).toEqual(progress);
    const jobs = await deps.deployments.listByTenantAndEvent(fixtureTenantId, fixtureEventId);
    const job = jobs.find((row) => row.teamId === progress.teamId);
    if (!job) throw new Error("Allocated deployment missing");
    await deps.deployments.putDeployment({
      ...job,
      status: "COMPLETE",
      teamLoginKey: "1".repeat(43),
    });
    const ready = await (await app.request(`${base}/status`, request(receipt))).json();
    expect(ready).toMatchObject({ state: "ready", teamLoginKey: "1".repeat(43) });
    expect(await deps.deployments.listByTeamLoginKey(ready.teamLoginKey)).toHaveLength(1);
  });

  it("rejects malformed or unauthorized requests without reserving a slot", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    expect((await app.request(`${base}/info`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`${base}/info`, request(receipt))).status).toBe(404);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt: "short" }))).status,
    ).toBe(400);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt, teamId: "another" })))
        .status,
    ).toBe(400);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt: "x".repeat(2048) })))
        .status,
    ).toBe(413);
    expect((await app.request(`${base}/delete`, request(invitation))).status).toBe(404);
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toHaveLength(0);
  });

  it.each([
    `/portal/registration/_invalid/${fixtureEventId}/info`,
    `/portal/registration/${"a".repeat(129)}/${fixtureEventId}/info`,
    `/portal/registration/${fixtureTenantId}/not-an-event/info`,
    `${base}/delete`,
  ])("rejects invalid route %s before consuming a rate-limit token", async (url) => {
    const { app, invitation } = await registrationHttpFixture();
    const response = await app.request(url, request(invitation));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(participantRateLimiter.snapshot().size).toBe(0);
  });

  it.each([
    "Basic credentials",
    "Bearer short",
    `Bearer ${"!".repeat(43)}`,
  ])("rejects malformed authorization %s before accessing repositories", async (authorization) => {
    const { app, shared } = await registrationHttpFixture();
    const resolve = vi.spyOn(shared.runtime, "resolveRepositories");
    const response = await app.request(`${base}/claim`, {
      ...request(receipt, { receipt }),
      headers: { Authorization: authorization, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    "{}",
    '{"receipt":123}',
  ])("rejects invalid claim JSON %s without changing the pool", async (body) => {
    const { app, invitation, deps } = await registrationHttpFixture();
    const response = await app.request(`${base}/claim`, { ...request(invitation), body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toEqual([]);
  });

  it("enforces the 1024-byte body limit before accessing repositories", async () => {
    const { app, invitation, shared } = await registrationHttpFixture();
    const resolve = vi.spyOn(shared.runtime, "resolveRepositories");
    const response = await app.request(`${base}/claim`, {
      ...request(invitation),
      body: " ".repeat(1025),
    });
    expect(response.status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
    expect(participantRateLimiter.snapshot().size).toBe(0);
  });

  it("does not authorize another tenant or event with a valid invitation or receipt", async () => {
    const { app, invitation } = await registrationHttpFixture();
    expect((await app.request(`${base}/claim`, request(invitation, { receipt }))).status).toBe(200);
    for (const otherBase of [
      `/portal/registration/other-tenant/${fixtureEventId}`,
      `/portal/registration/${fixtureTenantId}/01ARZ3NDEKTSV4RRFFQ69G5FAW`,
    ]) {
      for (const [action, token] of [
        ["info", invitation],
        ["claim", invitation],
        ["status", receipt],
      ]) {
        const response = await app.request(`${otherBase}/${action}`, request(token, { receipt }));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }
    const unclaimed = await app.request(`${base}/status`, request("s".repeat(43)));
    expect(unclaimed.status).toBe(404);
    expect(await unclaimed.json()).toEqual({ error: "not_found" });
  });

  it("returns full for a third participant while preserving repeat-claim recovery", async () => {
    const { app, invitation, deps } = await registrationHttpFixture();
    for (const token of [receipt, "s".repeat(43)]) {
      expect(
        (await app.request(`${base}/claim`, request(invitation, { receipt: token }))).status,
      ).toBe(200);
    }
    const response = await app.request(
      `${base}/claim`,
      request(invitation, { receipt: "t".repeat(43) }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "full" });
    expect(await (await app.request(`${base}/info`, request(invitation))).json()).toMatchObject({
      state: "full",
      remaining: 0,
    });
    expect((await app.request(`${base}/claim`, request(invitation, { receipt }))).status).toBe(200);
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toHaveLength(2);
  });

  it("returns closed after the operator closes registration without consuming a slot", async () => {
    const { app, invitation, deps } = await registrationHttpFixture();
    await configureRegistration(deps, fixtureTenantId, fixtureEventId, { enabled: false });
    const response = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "closed" });
    expect(await (await app.request(`${base}/info`, request(invitation))).json()).toMatchObject({
      state: "closed",
      remaining: 2,
    });
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toEqual([]);
  });

  it("returns conflict when conditional writes cannot reserve a slot", async () => {
    const { app, invitation, deps, sql } = await registrationHttpFixture();
    await sql.run(
      "CREATE TRIGGER reject_registration BEFORE UPDATE ON events BEGIN SELECT RAISE(IGNORE); END",
    );
    const response = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toEqual([]);
  });

  it.each([
    ["info", 100],
    ["claim", 100],
    ["status", 60],
  ] as const)("limits %s per bearer and resumes after its Retry-After delay", async (action, capacity) => {
    const { app, invitation } = await registrationHttpFixture();
    expect((await app.request(`${base}/claim`, request(invitation, { receipt }))).status).toBe(200);
    participantRateLimiter.reset();
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now);
    const token = action === "status" ? receipt : invitation;
    for (let index = 0; index < capacity; index++) {
      const response = await app.request(`${base}/${action}`, request(token, { receipt }));
      expect(response.status).toBe(200);
    }
    const limited = await app.request(`${base}/${action}`, request(token, { receipt }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("Retry-After")).toBe("1");
    const otherAction = action === "status" ? "info" : "status";
    expect(
      (
        await app.request(
          `${base}/${otherAction}`,
          request(otherAction === "info" ? invitation : receipt),
        )
      ).status,
    ).toBe(200);
    const differentToken = await app.request(
      `${base}/${action}`,
      request("z".repeat(43), { receipt }),
    );
    expect(differentToken.status).toBe(404);
    time.mockReturnValue(now + 1000);
    expect((await app.request(`${base}/${action}`, request(token, { receipt }))).status).toBe(200);
  });

  it("supports SQL repositories without a DynamoDB teams table name", async () => {
    const { shared, invitation } = await registrationHttpFixture();
    const app = new Hono();
    const resolve = vi.spyOn(shared.runtime, "resolveRepositories");
    registerPublicRegistrationRoutes(app, { ...shared, teamsTableName: undefined });
    const response = await app.request(`${base}/info`, request(invitation));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "open", remaining: 2 });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ teamsTableName: "" }));
  });

  it("returns unavailable on a real storage failure without leaking secrets or SQL details", async () => {
    const { app, invitation, sql } = await registrationHttpFixture();
    await sql.run("DROP TABLE events");
    const errors = vi.spyOn(console, "error");
    const response = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "registration_unavailable" });
    expect(errors).toHaveBeenCalledWith("[registration] operation failed", { name: "Error" });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/no such table|invitation|receipt/);
  });

  it("contains non-Error dependency failures without logging the thrown value", async () => {
    const { app, invitation, shared } = await registrationHttpFixture();
    vi.spyOn(shared.runtime, "resolveRepositories").mockRejectedValueOnce(`secret: ${invitation}`);
    const errors = vi.spyOn(console, "error");
    const response = await app.request(`${base}/info`, request(invitation));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "registration_unavailable" });
    expect(errors).toHaveBeenCalledWith("[registration] operation failed", { name: "unknown" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(invitation);
  });
});
