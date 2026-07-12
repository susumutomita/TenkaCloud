import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { organizerForTest, teamForTest } from "../src/auth.js";
import type { AppEnvironment } from "../src/types.js";

const ROLES_CLAIM = "https://tenkacloud.dev/roles";

let oidcPrivateJwk: JsonWebKey & { kid?: string };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  oidcPrivateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  oidcPrivateJwk.kid = "worker-command-key";
});

function organizerApp(payload: unknown) {
  return createApp({
    organizerJwt: createMiddleware<AppEnvironment>(async (context, next) => {
      context.set("jwtPayload", payload);
      await next();
    }),
  });
}

async function seedProjection(suspended = false): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind("org_acme", "tenant-acme", suspended ? 1 : 0, new Date().toISOString())
    .run();
}

function adminPayload(roles: readonly string[] = ["TenantAdmin"]) {
  return {
    sub: "auth0|organizer",
    org_id: "org_acme",
    [ROLES_CLAIM]: roles,
  };
}

function json(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(`
    DELETE FROM submissions;
    DELETE FROM score_summary;
    DELETE FROM challenge_checkpoints;
    DELETE FROM teams;
    DELETE FROM events;
    DELETE FROM tenant_auth_projection;
  `);
});

describe("always-on control plane Worker", () => {
  it("should serve health and the stable runtime-config contract without authentication", async () => {
    const app = organizerApp(adminPayload());
    const health = await app.request("https://control.example/health", undefined, env);
    expect(health.status).toBe(StatusCodes.OK);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      service: "tenkacloud-always-on-control-plane",
    });

    const config = await app.request("https://control.example/runtime-config.json", undefined, env);
    await expect(config.json()).resolves.toMatchObject({
      apiBaseUrl: "https://control.example",
      auth: {
        provider: "auth0",
        audience: env.AUTH0_AUDIENCE,
        clientId: env.AUTH0_CLIENT_ID,
      },
    });
  });

  it("should serve Worker OIDC discovery and JWKS without exposing private key material", async () => {
    const app = organizerApp(adminPayload());
    const oidcEnv = { ...env, INTENT_SIGNING_PRIVATE_JWK: JSON.stringify(oidcPrivateJwk) };

    const discovery = await app.request(
      "https://control.example/.well-known/openid-configuration",
      undefined,
      oidcEnv,
    );
    expect(discovery.status).toBe(StatusCodes.OK);
    await expect(discovery.json()).resolves.toMatchObject({
      issuer: "https://control.example",
      jwks_uri: "https://control.example/.well-known/jwks.json",
      id_token_signing_alg_values_supported: ["ES256"],
    });

    const jwks = await app.request(
      "https://control.example/.well-known/jwks.json",
      undefined,
      oidcEnv,
    );
    expect(jwks.status).toBe(StatusCodes.OK);
    await expect(jwks.json()).resolves.toEqual({
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          x: oidcPrivateJwk.x,
          y: oidcPrivateJwk.y,
          kid: "worker-command-key",
          use: "sig",
          alg: "ES256",
        },
      ],
    });
  });

  it("should fail closed when the Worker OIDC signing key is not configured", async () => {
    const response = await organizerApp(adminPayload()).request(
      "https://control.example/.well-known/jwks.json",
      undefined,
      env,
    );

    expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    await expect(response.json()).resolves.toEqual({
      error: "INTENT_SIGNING_PRIVATE_JWK is required for the Worker OIDC JWKS",
    });
  });

  it("should fail closed for malformed, unmapped, suspended, and underprivileged organizers", async () => {
    await seedProjection();
    const noToken = await createApp().request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(noToken.status).toBe(StatusCodes.UNAUTHORIZED);

    const invalidPayload = await organizerApp(null).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(invalidPayload.status).toBe(StatusCodes.UNAUTHORIZED);

    const malformed = await organizerApp({ sub: "auth0|organizer" }).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(malformed.status).toBe(StatusCodes.UNAUTHORIZED);

    const unmapped = await organizerApp({
      ...adminPayload(),
      org_id: "org_unknown",
    }).request("https://control.example/v1/admin/events", undefined, env);
    expect(unmapped.status).toBe(StatusCodes.FORBIDDEN);

    await env.CONTROL_DB.prepare("UPDATE tenant_auth_projection SET suspended = 1 WHERE org_id = ?")
      .bind("org_acme")
      .run();
    const suspended = await organizerApp(adminPayload()).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(suspended.status).toBe(StatusCodes.FORBIDDEN);

    await env.CONTROL_DB.prepare("UPDATE tenant_auth_projection SET suspended = 0 WHERE org_id = ?")
      .bind("org_acme")
      .run();
    const viewerWrite = await organizerApp(adminPayload(["TenantViewer"])).request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "Denied" }),
      env,
    );
    expect(viewerWrite.status).toBe(StatusCodes.FORBIDDEN);
  });

  it("should run event creation, team handoff, multi-checkpoint scoring, and leaderboard end to end", async () => {
    await seedProjection();
    const app = organizerApp(adminPayload());

    const createEvent = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", {
        name: "Security Championship",
        startsAt: "2026-08-01T00:00:00.000Z",
      }),
      env,
    );
    expect(createEvent.status).toBe(StatusCodes.CREATED);
    const event = (await createEvent.json()) as { eventId: string };

    const list = await app.request("https://control.example/v1/admin/events", undefined, env);
    const listBody = (await list.json()) as { items: Array<{ eventId: string }> };
    expect(listBody.items.map((item) => item.eventId)).toEqual([event.eventId]);

    const createTeam = await app.request(
      `https://control.example/v1/admin/events/${event.eventId}/teams`,
      json("POST", { displayName: "Blue Team" }),
      env,
    );
    expect(createTeam.status).toBe(StatusCodes.CREATED);
    const team = (await createTeam.json()) as { teamId: string; loginKey: string };
    expect(team.loginKey.length).toBeGreaterThan(30);
    const storedTeam = await env.CONTROL_DB.prepare(
      "SELECT login_key_hash FROM teams WHERE team_id = ?",
    )
      .bind(team.teamId)
      .first<{ login_key_hash: string }>();
    expect(storedTeam?.login_key_hash).not.toBe(team.loginKey);

    for (const checkpoint of [
      { checkpointId: "discovery", flag: "FLAG{first}", points: 10 },
      { checkpointId: "exploit", flag: "FLAG{second}", points: 20 },
    ]) {
      const response = await app.request(
        `https://control.example/v1/admin/events/${event.eventId}/checkpoints`,
        json("PUT", { problemId: "sqli-demo", ...checkpoint }),
        env,
      );
      expect(response.status).toBe(StatusCodes.NO_CONTENT);
    }

    const portalMe = await app.request(
      "https://control.example/v1/portal/me",
      { headers: { authorization: `Bearer ${team.loginKey}` } },
      env,
    );
    await expect(portalMe.json()).resolves.toMatchObject({
      teamId: team.teamId,
      eventId: event.eventId,
      displayName: "Blue Team",
    });

    const incorrect = await app.request(
      "https://control.example/v1/portal/flags",
      json(
        "POST",
        {
          eventId: event.eventId,
          problemId: "sqli-demo",
          checkpointId: "discovery",
          flag: "wrong",
        },
        team.loginKey,
      ),
      env,
    );
    expect(incorrect.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    await expect(incorrect.json()).resolves.toEqual({ result: "incorrect" });

    for (const [checkpointId, flag] of [
      ["discovery", "FLAG{first}"],
      ["exploit", "FLAG{second}"],
    ] as const) {
      const solved = await app.request(
        "https://control.example/v1/portal/flags",
        json(
          "POST",
          { eventId: event.eventId, problemId: "sqli-demo", checkpointId, flag },
          team.loginKey,
        ),
        env,
      );
      await expect(solved.json()).resolves.toEqual({ result: "solved" });
    }

    const duplicate = await app.request(
      "https://control.example/v1/portal/flags",
      json(
        "POST",
        {
          eventId: event.eventId,
          problemId: "sqli-demo",
          checkpointId: "exploit",
          flag: "FLAG{second}",
        },
        team.loginKey,
      ),
      env,
    );
    await expect(duplicate.json()).resolves.toEqual({ result: "already_solved" });
    const awarded = await env.CONTROL_DB.prepare(
      "SELECT awarded_points FROM submissions WHERE team_id = ? ORDER BY checkpoint_id",
    )
      .bind(team.teamId)
      .all<{ awarded_points: number }>();
    expect(awarded.results.map((row) => row.awarded_points)).toEqual([10, 20]);

    const leaderboard = await app.request(
      `https://control.example/v1/portal/events/${event.eventId}/leaderboard`,
      { headers: { authorization: `Bearer ${team.loginKey}` } },
      env,
    );
    await expect(leaderboard.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          teamId: team.teamId,
          displayName: "Blue Team",
          score: 30,
          solvedCheckpoints: 2,
        }),
      ],
    });

    await env.CONTROL_DB.prepare(
      "UPDATE tenant_auth_projection SET suspended = 1 WHERE tenant_id = ?",
    )
      .bind("tenant-acme")
      .run();
    const suspendedTeam = await app.request(
      "https://control.example/v1/portal/me",
      { headers: { authorization: `Bearer ${team.loginKey}` } },
      env,
    );
    expect(suspendedTeam.status).toBe(StatusCodes.FORBIDDEN);
  });

  it("should reject invalid team credentials, cross-event reads, and malformed bodies", async () => {
    await seedProjection();
    const app = organizerApp(adminPayload());
    const missingBearer = await app.request("https://control.example/v1/portal/me", undefined, env);
    expect(missingBearer.status).toBe(StatusCodes.UNAUTHORIZED);

    const invalidBearer = await app.request(
      "https://control.example/v1/portal/me",
      { headers: { authorization: "Bearer invalid" } },
      env,
    );
    expect(invalidBearer.status).toBe(StatusCodes.UNAUTHORIZED);

    const invalidJson = await app.request(
      "https://control.example/v1/admin/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(invalidJson.status).toBe(StatusCodes.BAD_REQUEST);

    const nonObjectBody = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", []),
      env,
    );
    expect(nonObjectBody.status).toBe(StatusCodes.BAD_REQUEST);

    const blankName = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "  " }),
      env,
    );
    expect(blankName.status).toBe(StatusCodes.BAD_REQUEST);

    const invalidOptionalDate = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "Invalid date", startsAt: 123 }),
      env,
    );
    expect(invalidOptionalDate.status).toBe(StatusCodes.BAD_REQUEST);

    const invalidPoints = await app.request(
      "https://control.example/v1/admin/events/missing/checkpoints",
      json("PUT", {
        problemId: "sqli-demo",
        checkpointId: "one",
        flag: "FLAG",
        points: 0,
      }),
      env,
    );
    expect(invalidPoints.status).toBe(StatusCodes.BAD_REQUEST);

    const missingTeamEvent = await app.request(
      "https://control.example/v1/admin/events/missing/teams",
      json("POST", { displayName: "No event" }),
      env,
    );
    expect(missingTeamEvent.status).toBe(StatusCodes.NOT_FOUND);

    const missingCheckpointEvent = await app.request(
      "https://control.example/v1/admin/events/missing/checkpoints",
      json("PUT", {
        problemId: "sqli-demo",
        checkpointId: "one",
        flag: "FLAG",
        points: 10,
      }),
      env,
    );
    expect(missingCheckpointEvent.status).toBe(StatusCodes.NOT_FOUND);

    const oversized = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "x".repeat(33 * 1024) }),
      env,
    );
    expect(oversized.status).toBe(StatusCodes.REQUEST_TOO_LONG);

    const teamApp = createApp({
      teamAuth: teamForTest({
        teamId: "team-a",
        eventId: "event-a",
        displayName: "A",
      }),
    });
    const crossEventRead = await teamApp.request(
      "https://control.example/v1/portal/events/event-b/leaderboard",
      undefined,
      env,
    );
    expect(crossEventRead.status).toBe(StatusCodes.NOT_FOUND);
    const crossEventSubmit = await teamApp.request(
      "https://control.example/v1/portal/flags",
      json("POST", {
        eventId: "event-b",
        problemId: "sqli-demo",
        checkpointId: "one",
        flag: "FLAG",
      }),
      env,
    );
    expect(crossEventSubmit.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should return a sanitized 500 when storage fails unexpectedly", async () => {
    await seedProjection();
    await env.CONTROL_DB.prepare(
      `INSERT INTO events (
        event_id, tenant_id, name, status, created_at, updated_at
      ) VALUES ('event-failure', 'tenant-acme', 'Failure', 'DRAFT', 'now', 'now')`,
    ).run();
    await env.CONTROL_DB.prepare(`
      CREATE TRIGGER reject_team_insert
      BEFORE INSERT ON teams
      BEGIN
        SELECT RAISE(ABORT, 'simulated storage failure');
      END;
    `).run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await organizerApp(adminPayload()).request(
        "https://control.example/v1/admin/events/event-failure/teams",
        json("POST", { displayName: "Rejected" }),
        env,
      );
      expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      await expect(response.json()).resolves.toEqual({ error: "internal server error" });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('"event":"always-on.request.failed"'),
      );
    } finally {
      error.mockRestore();
      await env.CONTROL_DB.exec("DROP TRIGGER reject_team_insert;");
    }
  });

  it("should support deterministic organizer middleware injection for Worker tests", async () => {
    const organizer = {
      subject: "test|organizer",
      organizationId: "org_test",
      tenantId: "tenant-test",
      roles: ["TenantViewer"],
    };
    const app = createApp({
      organizerJwt: organizerForTest(organizer),
      organizerProjection: organizerForTest(organizer),
    });
    const response = await app.request("https://control.example/v1/admin/events", undefined, env);
    expect(response.status).toBe(StatusCodes.OK);
  });
});
