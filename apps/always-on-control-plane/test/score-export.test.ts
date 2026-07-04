import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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

function payload(org: string, roles: readonly string[]) {
  return { sub: "auth0|op", org_id: org, [ROLES_CLAIM]: roles };
}

async function seedProjection(org: string, tenant: string): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
     VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')`,
  )
    .bind(org, tenant)
    .run();
}

async function seedScoredEvent(tenant: string, eventId: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await env.CONTROL_DB.prepare(
    `INSERT INTO events (event_id, tenant_id, name, status, created_at, updated_at)
     VALUES (?, ?, 'E', 'ACTIVE', ?, ?)`,
  )
    .bind(eventId, tenant, now, now)
    .run();
  // Team insert seeds a score_summary 0-row via trigger.
  await env.CONTROL_DB.prepare(
    `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
     VALUES ('team-1', ?, ?, 'Alpha', 'hash', ?)`,
  )
    .bind(eventId, tenant, now)
    .run();
  await env.CONTROL_DB.prepare(
    `INSERT INTO challenge_checkpoints (event_id, problem_id, checkpoint_id, flag_hash, points)
     VALUES (?, 'p1', 'c1', 'fh', 10)`,
  )
    .bind(eventId)
    .run();
  // Submission insert updates score_summary via trigger.
  await env.CONTROL_DB.prepare(
    `INSERT INTO submissions (event_id, team_id, problem_id, checkpoint_id, awarded_points, submitted_at)
     VALUES (?, 'team-1', 'p1', 'c1', 10, '2026-07-04T10:00:00.000Z')`,
  )
    .bind(eventId)
    .run();
  await env.CONTROL_DB.prepare(
    `INSERT INTO runtime_score (event_id, team_id, points, updated_at)
     VALUES (?, 'team-1', 25, '2026-07-04T11:00:00.000Z')`,
  )
    .bind(eventId)
    .run();
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(`
    DELETE FROM runtime_score;
    DELETE FROM submissions;
    DELETE FROM score_summary;
    DELETE FROM challenge_checkpoints;
    DELETE FROM teams;
    DELETE FROM events;
    DELETE FROM tenant_auth_projection;
  `);
});

describe("GET /v1/admin/events/:eventId/export (#2294)", () => {
  it("should export the raw scoring rows for a tenant-owned event", async () => {
    await seedProjection("org_acme", "tenant-acme");
    await seedScoredEvent("tenant-acme", "evt");
    const res = await organizerApp(payload("org_acme", ["TenantAdmin"])).request(
      "https://control.example/v1/admin/events/evt/export",
      undefined,
      env,
    );
    expect(res.status).toBe(StatusCodes.OK);
    await expect(res.json()).resolves.toEqual({
      eventId: "evt",
      scoreSummary: [
        {
          teamId: "team-1",
          score: 10,
          solvedCheckpoints: 1,
          updatedAt: "2026-07-04T10:00:00.000Z",
        },
      ],
      runtimeScores: [{ teamId: "team-1", points: 25, updatedAt: "2026-07-04T11:00:00.000Z" }],
      submissions: [
        {
          teamId: "team-1",
          problemId: "p1",
          checkpointId: "c1",
          awardedPoints: 10,
          submittedAt: "2026-07-04T10:00:00.000Z",
        },
      ],
    });
  });

  it("should allow a read-only organizer role", async () => {
    await seedProjection("org_acme", "tenant-acme");
    await seedScoredEvent("tenant-acme", "evt");
    const res = await organizerApp(payload("org_acme", ["TenantViewer"])).request(
      "https://control.example/v1/admin/events/evt/export",
      undefined,
      env,
    );
    expect(res.status).toBe(StatusCodes.OK);
  });

  it("should 404 an event owned by another tenant or absent (tenant isolation)", async () => {
    await seedProjection("org_acme", "tenant-acme");
    await seedScoredEvent("tenant-other", "evt-other");
    const app = organizerApp(payload("org_acme", ["TenantAdmin"]));

    const foreign = await app.request(
      "https://control.example/v1/admin/events/evt-other/export",
      undefined,
      env,
    );
    expect(foreign.status).toBe(StatusCodes.NOT_FOUND);

    const missing = await app.request(
      "https://control.example/v1/admin/events/nope/export",
      undefined,
      env,
    );
    expect(missing.status).toBe(StatusCodes.NOT_FOUND);
  });
});
