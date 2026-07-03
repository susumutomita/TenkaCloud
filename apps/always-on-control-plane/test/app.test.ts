import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { organizerForTest, teamForTest } from "../src/auth.js";
import type { AppEnvironment } from "../src/types.js";

const ROLES_CLAIM = "https://tenkacloud.dev/roles";

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
  it("serves health and the stable runtime-config contract without authentication", async () => {
    const app = organizerApp(adminPayload());
    const health = await app.request("https://control.example/health", undefined, env);
    expect(health.status).toBe(200);
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

  it("fails closed for malformed, unmapped, suspended, and underprivileged organizers", async () => {
    await seedProjection();
    const noToken = await createApp().request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(noToken.status).toBe(401);

    const invalidPayload = await organizerApp(null).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(invalidPayload.status).toBe(401);

    const malformed = await organizerApp({ sub: "auth0|organizer" }).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(malformed.status).toBe(401);

    const unmapped = await organizerApp({
      ...adminPayload(),
      org_id: "org_unknown",
    }).request("https://control.example/v1/admin/events", undefined, env);
    expect(unmapped.status).toBe(403);

    await env.CONTROL_DB.prepare("UPDATE tenant_auth_projection SET suspended = 1 WHERE org_id = ?")
      .bind("org_acme")
      .run();
    const suspended = await organizerApp(adminPayload()).request(
      "https://control.example/v1/admin/events",
      undefined,
      env,
    );
    expect(suspended.status).toBe(403);

    await env.CONTROL_DB.prepare("UPDATE tenant_auth_projection SET suspended = 0 WHERE org_id = ?")
      .bind("org_acme")
      .run();
    const viewerWrite = await organizerApp(adminPayload(["TenantViewer"])).request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "Denied" }),
      env,
    );
    expect(viewerWrite.status).toBe(403);
  });

  it("runs event creation, team handoff, multi-checkpoint scoring, and leaderboard end to end", async () => {
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
    expect(createEvent.status).toBe(201);
    const event = (await createEvent.json()) as { eventId: string };

    const list = await app.request("https://control.example/v1/admin/events", undefined, env);
    const listBody = (await list.json()) as { items: Array<{ eventId: string }> };
    expect(listBody.items.map((item) => item.eventId)).toEqual([event.eventId]);

    const createTeam = await app.request(
      `https://control.example/v1/admin/events/${event.eventId}/teams`,
      json("POST", { displayName: "Blue Team" }),
      env,
    );
    expect(createTeam.status).toBe(201);
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
      expect(response.status).toBe(204);
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
    expect(incorrect.status).toBe(422);
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
  });

  it("rejects invalid team credentials, cross-event reads, and malformed bodies", async () => {
    await seedProjection();
    const app = organizerApp(adminPayload());
    const missingBearer = await app.request("https://control.example/v1/portal/me", undefined, env);
    expect(missingBearer.status).toBe(401);

    const invalidBearer = await app.request(
      "https://control.example/v1/portal/me",
      { headers: { authorization: "Bearer invalid" } },
      env,
    );
    expect(invalidBearer.status).toBe(401);

    const invalidJson = await app.request(
      "https://control.example/v1/admin/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(invalidJson.status).toBe(400);

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
    expect(invalidPoints.status).toBe(400);

    const missingTeamEvent = await app.request(
      "https://control.example/v1/admin/events/missing/teams",
      json("POST", { displayName: "No event" }),
      env,
    );
    expect(missingTeamEvent.status).toBe(404);

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
    expect(missingCheckpointEvent.status).toBe(404);

    const oversized = await app.request(
      "https://control.example/v1/admin/events",
      json("POST", { name: "x".repeat(33 * 1024) }),
      env,
    );
    expect(oversized.status).toBe(413);

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
    expect(crossEventRead.status).toBe(404);
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
    expect(crossEventSubmit.status).toBe(404);
  });

  it("supports deterministic organizer middleware injection for Worker tests", async () => {
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
    expect(response.status).toBe(200);
  });
});
