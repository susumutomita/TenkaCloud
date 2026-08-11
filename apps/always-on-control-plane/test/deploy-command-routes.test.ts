import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { commandGatewayFromEnvironment, executeDeployCommand } from "../src/deploy-commands.js";
import { ControlStore } from "../src/store.js";
import type { AppEnvironment } from "../src/types.js";
import { decodeJwtPayload, fakeAwsFetch } from "./helpers/aws-capture.js";

/**
 * Issue #2555: the organizer deploy/destroy route over the
 * OIDC command seam: mint → AssumeRoleWithWebIdentity → PutEvents, with the
 * frozen `tenkacloud.deploy` event shape pinned end to end.
 */

const ROLES_CLAIM = "https://tenkacloud.dev/roles";
const PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "1eKmOOWu-FOaKedtieKvK2YrtlFl7GaMzDoAq36I07c",
  y: "LT1bJ_zI98s8BQxrpCV1MhuCO7CrO8VfLVLt5zqP4D8",
  d: "nGPyjamYMjRaOqgyKGX6uktZkAEXUb8ujIXC1JtGDX0",
};
const CATALOG = { "hello-world": "problems/challenges/hello-world" };
const AWS_ACCOUNT_ID = "111111111111";
const COMPETITOR_ROLE_ARN = `arn:aws:iam::${AWS_ACCOUNT_ID}:role/TenkaCloud-tenant-acme-deploy-Role`;
const EXTERNAL_ID_PARAM = "/dev/tenants/tenant-acme/external-id";

function commandEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(PRIVATE_JWK),
    PROBLEMS_CATALOG: JSON.stringify(CATALOG),
    ...overrides,
  } as typeof env;
}

function organizerApp(payload: unknown, commandFetch?: typeof fetch) {
  return createApp({
    organizerJwt: createMiddleware<AppEnvironment>(async (context, next) => {
      context.set("jwtPayload", payload);
      await next();
    }),
    ...(commandFetch === undefined ? {} : { commandFetch }),
  });
}

function adminPayload(roles: readonly string[] = ["TenantAdmin"]) {
  return { sub: "auth0|organizer", org_id: "org_acme", [ROLES_CLAIM]: roles };
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function seedProjection(): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
     VALUES (?, ?, 0, ?)`,
  )
    .bind("org_acme", "tenant-acme", new Date().toISOString())
    .run();
}

async function seedAccount(): Promise<void> {
  await new ControlStore(env.CONTROL_DB).upsertCompetitorAccountProjection({
    tenantId: "tenant-acme",
    awsAccountId: AWS_ACCOUNT_ID,
    competitorRoleArn: COMPETITOR_ROLE_ARN,
    externalIdParameterName: EXTERNAL_ID_PARAM,
  });
}

async function createEventAndTeam(app: ReturnType<typeof createApp>) {
  const eventRes = await app.request(
    "https://control.example/v1/admin/events",
    json("POST", { name: "Battle Day" }),
    commandEnv(),
  );
  const { eventId } = (await eventRes.json()) as { eventId: string };
  const teamRes = await app.request(
    `https://control.example/v1/admin/events/${eventId}/teams`,
    json("POST", { displayName: "Team Alpha" }),
    commandEnv(),
  );
  const { teamId } = (await teamRes.json()) as { teamId: string };
  return { eventId, teamId };
}

function deployBody(teamId: string, overrides: Record<string, unknown> = {}) {
  return {
    action: "deploy",
    teamId,
    problemId: "hello-world",
    awsAccountId: AWS_ACCOUNT_ID,
    region: "ap-northeast-1",
    ...overrides,
  };
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(
    "DELETE FROM tenant_auth_projection; DELETE FROM events; DELETE FROM competitor_account_projection;",
  );
  await seedProjection();
  await seedAccount();
});

describe("POST /v1/admin/events/:eventId/deploy-intents (OIDC command seam)", () => {
  it("should publish the frozen DeployCreateRequested event and return 202", async () => {
    const { fetchImpl, stsCalls, putEventsCalls } = fakeAwsFetch();
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    const { requestId, deploymentId } = (await res.json()) as {
      requestId: string;
      deploymentId: string;
    };
    expect(deploymentId).toBe(requestId);

    // STS leg: the minted token is scoped to this tenant/event and aud=STS.
    expect(stsCalls).toHaveLength(1);
    const token = stsCalls[0]?.params.get("WebIdentityToken") ?? "";
    const claims = decodeJwtPayload(token);
    expect(claims.iss).toBe("https://control.example");
    expect(claims.aud).toBe("sts.amazonaws.com");
    expect(claims.sub).toBe(`tenkacloud:always-on:command:tenant-acme:${eventId}`);

    // Publish leg: the frozen detail, byte-compatible with the retired ingress.
    expect(putEventsCalls).toHaveLength(1);
    const entry = putEventsCalls[0]?.body.Entries[0] as Record<string, unknown>;
    expect(entry.Source).toBe("tenkacloud.deploy");
    expect(entry.DetailType).toBe("DeployCreateRequested");
    expect(entry.Resources).toEqual([`tenkacloud:deployment:${deploymentId}`]);
    const detail = JSON.parse(entry.Detail as string) as Record<string, unknown>;
    expect(detail).toEqual({
      jobId: deploymentId,
      correlationId: requestId,
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: teamId
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .slice(0, 40),
      namePrefix: `tc-hello-world-${teamId
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .slice(0, 40)}`,
      region: "ap-northeast-1",
      awsAccountId: AWS_ACCOUNT_ID,
      competitorRoleArn: COMPETITOR_ROLE_ARN,
      externalIdParameterName: EXTERNAL_ID_PARAM,
    });
  });

  it("should carry the original deploymentId through a destroy as the jobId", async () => {
    const { fetchImpl, putEventsCalls } = fakeAwsFetch();
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);

    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { action: "destroy", deploymentId: "deploy-123" })),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    const { deploymentId } = (await res.json()) as { deploymentId: string };
    expect(deploymentId).toBe("deploy-123");

    const entry = putEventsCalls[0]?.body.Entries[0] as Record<string, unknown>;
    expect(entry.DetailType).toBe("DeployDeleteRequested");
    const detail = JSON.parse(entry.Detail as string) as Record<string, unknown>;
    expect(detail.jobId).toBe("deploy-123");
    expect(detail.stackName).toMatch(/^tc-hello-world-/u);
    expect(detail.problemDir).toBeUndefined();
    expect(detail.competitorRoleArn).toBe(COMPETITOR_ROLE_ARN);
  });

  it("should reject a deploy that supplies a deploymentId", async () => {
    const app = organizerApp(adminPayload());
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { deploymentId: "nope" })),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should reject a destroy without the original deploymentId", async () => {
    const app = organizerApp(adminPayload());
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { action: "destroy" })),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should return 404 for a team outside the organizer's event", async () => {
    const { fetchImpl } = fakeAwsFetch();
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody("team-of-someone-else")),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should return 422 for a problem missing from the catalog", async () => {
    const { fetchImpl, stsCalls } = fakeAwsFetch();
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { problemId: "not-in-catalog" })),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect(((await res.json()) as { reason: string }).reason).toBe("unknown-problem-dir");
    expect(stsCalls).toHaveLength(0);
  });

  it("should fail closed with 422 when the account is not registered for the tenant", async () => {
    const { fetchImpl, stsCalls } = fakeAwsFetch();
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId, { awsAccountId: "222222222222" })),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect(((await res.json()) as { reason: string }).reason).toBe("account-not-verified");
    expect(stsCalls).toHaveLength(0);
  });

  it("should map an STS trust rejection to 502 without publishing", async () => {
    const { fetchImpl, putEventsCalls } = fakeAwsFetch({ stsStatus: StatusCodes.FORBIDDEN });
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.BAD_GATEWAY);
    expect(((await res.json()) as { reason: string }).reason).toBe("sts-exchange-failed");
    expect(putEventsCalls).toHaveLength(0);
  });

  it("should map a failed publish to 502", async () => {
    const { fetchImpl } = fakeAwsFetch({ failedEntryCount: 1 });
    const app = organizerApp(adminPayload(), fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.BAD_GATEWAY);
    expect(((await res.json()) as { reason: string }).reason).toBe("event-publish-failed");
  });

  it("should fail loudly (500) when the problems catalog binding is malformed", async () => {
    const app = organizerApp(adminPayload(), fakeAwsFetch().fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv({ PROBLEMS_CATALOG: "{nope" }),
    );
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });

  it("should refuse a read-only organizer role", async () => {
    const app = organizerApp(adminPayload(["TenantViewer"]));
    const res = await app.request(
      "https://control.example/v1/admin/events/some-event/deploy-intents",
      json("POST", deployBody("team-1")),
      commandEnv(),
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
  });

  it.each([
    ["an array", "[]"],
    ["an empty problemDir value", JSON.stringify({ "hello-world": "" })],
  ])("should fail loudly (500) when the catalog binding is %s", async (_case, catalog) => {
    const app = organizerApp(adminPayload(), fakeAwsFetch().fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv({ PROBLEMS_CATALOG: catalog }),
    );
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });

  it("should fail loudly (500) when the command role binding is missing", async () => {
    const app = organizerApp(adminPayload(), fakeAwsFetch().fetchImpl);
    const { eventId, teamId } = await createEventAndTeam(app);
    const res = await app.request(
      `https://control.example/v1/admin/events/${eventId}/deploy-intents`,
      json("POST", deployBody(teamId)),
      commandEnv({ COMMAND_ROLE_ARN: "" }),
    );
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});

describe("executeDeployCommand (module edge cases)", () => {
  it("should reject a team whose id slugifies to nothing", async () => {
    const gateway = commandGatewayFromEnvironment(
      {
        COMMAND_ROLE_ARN: "arn:aws:iam::111111111111:role/x",
        COMMAND_AWS_REGION: "ap-northeast-1",
        COMMAND_EVENT_BUS_ARN: "arn:aws:events:ap-northeast-1:111111111111:event-bus/x",
        PROBLEMS_CATALOG: JSON.stringify(CATALOG),
        OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(PRIVATE_JWK),
      },
      fakeAwsFetch().fetchImpl,
    );
    const outcome = await executeDeployCommand(
      {
        action: "deploy",
        teamId: "チーム",
        problemId: "hello-world",
        awsAccountId: AWS_ACCOUNT_ID,
        region: "ap-northeast-1",
        tenantId: "tenant-acme",
        eventId: "event-1",
        issuer: "https://control.example",
      },
      gateway,
      async () => ({
        competitorRoleArn: COMPETITOR_ROLE_ARN,
        externalIdParameterName: EXTERNAL_ID_PARAM,
      }),
    );
    expect(outcome).toEqual({ accepted: false, kind: "rejected", reason: "team-slug-invalid" });
  });
});
