import { verifyIntent } from "@TenkaCloud/trust-bridge";
import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppEnvironment } from "../src/types.js";
import {
  acceptedIngressResponse,
  capturedAt,
  capturedToken,
  captureFetch,
} from "./helpers/intent-capture.js";

const ROLES_CLAIM = "https://tenkacloud.dev/roles";
let PRIVATE_JWK: JsonWebKey;
let PUBLIC_JWK: JsonWebKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  PRIVATE_JWK = await crypto.subtle.exportKey("jwk", pair.privateKey);
  PUBLIC_JWK = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

function organizerApp(payload: unknown, intentFetch?: typeof fetch) {
  return createApp({
    organizerJwt: createMiddleware<AppEnvironment>(async (context, next) => {
      context.set("jwtPayload", payload);
      await next();
    }),
    ...(intentFetch === undefined ? {} : { intentFetch }),
  });
}

async function seedProjection(): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
     VALUES (?, ?, 0, ?)`,
  )
    .bind("org_acme", "tenant-acme", new Date().toISOString())
    .run();
}

function adminPayload(roles: readonly string[] = ["TenantAdmin"]) {
  return {
    sub: "auth0|organizer",
    org_id: "org_acme",
    [ROLES_CLAIM]: roles,
  };
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function envWithPrivateKey() {
  return { ...env, INTENT_SIGNING_PRIVATE_JWK: JSON.stringify(PRIVATE_JWK) };
}

async function createEventAndTeam(app: ReturnType<typeof createApp>) {
  const eventRes = await app.request(
    "https://control.example/v1/admin/events",
    json("POST", { name: "Battle Day" }),
    envWithPrivateKey(),
  );
  const { eventId } = (await eventRes.json()) as { eventId: string };
  const teamRes = await app.request(
    `https://control.example/v1/admin/events/${eventId}/teams`,
    json("POST", { displayName: "Team Alpha" }),
    envWithPrivateKey(),
  );
  const { teamId } = (await teamRes.json()) as { teamId: string };
  return { eventId, teamId };
}

function deployBody(teamId: string, overrides: Record<string, unknown> = {}) {
  return {
    action: "deploy",
    problemId: "hello-world",
    teamId,
    awsAccountId: "111111111111",
    region: "ap-northeast-1",
    ...overrides,
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
  await seedProjection();
});

describe("POST /v1/admin/events/:eventId/deploy-intents (ADR-049 Phase 4 / #2293)", () => {
  it("should sign an intent for the organizer's tenant and POST it to the configured ingress", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      envWithPrivateKey(),
    );

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    const responseBody = (await res.json()) as { requestId: string; deploymentId: string };
    expect(responseBody.requestId).toEqual(expect.any(String));
    expect(responseBody.deploymentId).toBe(responseBody.requestId);

    expect(captured).toHaveLength(1);
    expect(capturedAt(captured, 0).url).toBe(env.INTENT_INGRESS_URL);
    const outcome = await verifyIntent(capturedToken(captured, 0), {
      resolvePublicKey: () => PUBLIC_JWK,
    });
    if (!outcome.ok) throw new Error(`token did not verify: ${outcome.reason}`);
    // tenantId comes from the organizer projection — never from the request body.
    expect(outcome.intent.source.tenantId).toBe("tenant-acme");
    expect(outcome.intent.source.eventId).toBe(eventId);
    expect(outcome.intent.source.teamId).toBe(teamId);
    expect(outcome.intent.requestId).toBe(responseBody.requestId);
    expect(outcome.intent.audience).toBe(env.INTENT_AUDIENCE);
  });

  it("should mint destroy intents that carry the original deploymentId", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { action: "destroy", deploymentId: "job-original" })),
      envWithPrivateKey(),
    );

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    await expect(res.json()).resolves.toEqual({
      requestId: expect.any(String),
      deploymentId: "job-original",
    });
    const outcome = await verifyIntent(capturedToken(captured, 0), {
      resolvePublicKey: () => PUBLIC_JWK,
    });
    if (!outcome.ok) throw new Error(`token did not verify: ${outcome.reason}`);
    expect(outcome.intent.action.type).toBe("destroy");
    expect(outcome.intent.source.deploymentId).toBe("job-original");
  });

  it("should reject malformed commands before anything is signed", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const url = `https://control.example/v1/admin/events/${eventId}/deploy-intents`;

    const cases: Record<string, unknown>[] = [
      deployBody(teamId, { action: "inspect" }),
      deployBody(teamId, { problemId: "Hello_World" }),
      deployBody(teamId, { awsAccountId: "1234" }),
      deployBody(teamId, { region: "AP-NORTHEAST-1" }),
      deployBody(teamId, { teamId: "" }),
      // deploymentId contract: a deploy must not supply it; a destroy must.
      deployBody(teamId, { deploymentId: "job-1" }),
      deployBody(teamId, { action: "destroy" }),
    ];
    for (const body of cases) {
      const res = await app.request(url, json("POST", body), envWithPrivateKey());
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    }
    expect(captured).toHaveLength(0);
  });

  it("should return 404 when the team does not belong to the organizer's tenant and event", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    // Unknown team in the organizer's own event.
    const unknownTeam = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(crypto.randomUUID())),
      envWithPrivateKey(),
    );
    expect(unknownTeam.status).toBe(StatusCodes.NOT_FOUND);

    // A real team, but reached through a different event path.
    const otherEvent = await app.request(
      `https://control.example/v1/admin/events/${crypto.randomUUID()}/deploy-intents`,
      json("POST", deployBody(teamId)),
      envWithPrivateKey(),
    );
    expect(otherEvent.status).toBe(StatusCodes.NOT_FOUND);

    // A team owned by another tenant must be invisible, even with a valid id.
    const now = new Date().toISOString();
    await env.CONTROL_DB.prepare(
      `INSERT INTO events (event_id, tenant_id, name, status, created_at, updated_at)
       VALUES ('other-event', 'tenant-other', 'Other', 'DRAFT', ?, ?)`,
    )
      .bind(now, now)
      .run();
    await env.CONTROL_DB.prepare(
      `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
       VALUES ('other-team', 'other-event', 'tenant-other', 'Other', 'hash', ?)`,
    )
      .bind(now)
      .run();
    const crossTenant = await app.request(
      "https://control.example/v1/admin/events/other-event/deploy-intents",
      json("POST", deployBody("other-team")),
      envWithPrivateKey(),
    );
    expect(crossTenant.status).toBe(StatusCodes.NOT_FOUND);
    expect(captured).toHaveLength(0);
  });

  it("should deny read-only organizer roles", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(["TenantViewer"]), fetchImpl);
    const res = await app.request(
      "https://control.example/v1/admin/events/some-event/deploy-intents",
      json("POST", deployBody("some-team")),
      envWithPrivateKey(),
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(captured).toHaveLength(0);
  });

  it("should map an ingress 4xx (rejected command) to 422 with the ingress' stable reason", async () => {
    const { fetchImpl } = captureFetch(
      () =>
        new Response(JSON.stringify({ reason: "unknown-problem-dir" }), {
          status: StatusCodes.UNPROCESSABLE_ENTITY,
        }),
    );
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      envWithPrivateKey(),
    );
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    await expect(res.json()).resolves.toEqual({
      error: "deploy intent rejected by ingress",
      reason: "unknown-problem-dir",
    });
  });

  it("should map an ingress 5xx to 502 with the ingress' stable reason", async () => {
    const { fetchImpl } = captureFetch(
      () =>
        new Response(JSON.stringify({ reason: "event-publish-failed" }), {
          status: StatusCodes.INTERNAL_SERVER_ERROR,
        }),
    );
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      envWithPrivateKey(),
    );
    expect(res.status).toBe(StatusCodes.BAD_GATEWAY);
    await expect(res.json()).resolves.toEqual({
      error: "deploy intent rejected by ingress",
      reason: "event-publish-failed",
    });
  });

  it("should map an unreachable ingress to 502 ingress-unreachable (not a generic 500)", async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const app = organizerApp(adminPayload(), failingFetch);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      envWithPrivateKey(),
    );
    expect(res.status).toBe(StatusCodes.BAD_GATEWAY);
    await expect(res.json()).resolves.toEqual({
      error: "deploy intent rejected by ingress",
      reason: "ingress-unreachable",
    });
  });

  it("should fail loudly (500) when the signing private JWK binding is absent", async () => {
    const { fetchImpl, captured } = captureFetch(acceptedIngressResponse);
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      env,
    );
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    await expect(res.json()).resolves.toEqual({ error: "internal server error" });
    expect(captured).toHaveLength(0);
  });
});
