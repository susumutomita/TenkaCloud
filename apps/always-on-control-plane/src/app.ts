import { DEPLOY_AWS_ACCOUNT_ID_PATTERN } from "@TenkaCloud/trust-bridge";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { StatusCodes } from "http-status-codes";
import {
  auth0JwtMiddleware,
  organizerProjectionMiddleware,
  requireOrganizerRole,
  runtimeFeedMiddleware,
  systemAdminMiddleware,
  teamBearerMiddleware,
} from "./auth.js";
import {
  CompetitorAccountRegistrationSchema,
  commandGatewayFromEnvironment,
  type DeployCommandInput,
  DeployCommandInputSchema,
  executeDeployCommand,
} from "./deploy-commands.js";
import {
  ORGANIZER_MCP_RESOURCE_METADATA_PATH,
  organizerMcpAuthenticationChallenge,
  organizerMcpResourceMetadata,
  serveMcp,
} from "./mcp.js";
import {
  buildOpenIdConfiguration,
  JWKS_PATH,
  OPENID_CONFIGURATION_PATH,
  publicJwkFromEnvironment,
} from "./oidc.js";
import { type CheckpointInput, ControlStore, type EventInput } from "./store.js";
import type { AppEnvironment } from "./types.js";

const MUTATING_ROLES = ["TenantAdmin", "TenantOperator"] as const;
const READING_ROLES = [...MUTATING_ROLES, "TenantViewer"] as const;
const MAX_RUNTIME_SCORES_PER_REQUEST = 100;
const MIN_RUNTIME_SCORE_POINTS = -2_147_483_648;
const MAX_RUNTIME_SCORE_POINTS = 2_147_483_647;

interface AppOptions {
  readonly organizerJwt?: MiddlewareHandler<AppEnvironment>;
  readonly organizerProjection?: MiddlewareHandler<AppEnvironment>;
  readonly teamAuth?: MiddlewareHandler<AppEnvironment>;
  /** System-admin gate for `/v1/system/*`; injectable for tests. */
  readonly systemAuth?: MiddlewareHandler<AppEnvironment>;
  /** Event-runtime score-feed gate for `/v1/runtime/*`; injectable for tests. */
  readonly runtimeAuth?: MiddlewareHandler<AppEnvironment>;
  /** Transport used to reach AWS (STS + EventBridge); injectable for tests. */
  readonly commandFetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: `${key} must be a non-empty string`,
    });
  }
  return value.trim();
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new HTTPException(StatusCodes.BAD_REQUEST, { message: `${key} must be a string` });
  }
  return value;
}

async function readObject(request: { json(): Promise<unknown> }): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: "request body must be valid JSON",
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: "request body must be a JSON object",
    });
  }
  return value as JsonObject;
}

function eventInput(body: JsonObject): EventInput {
  return {
    name: requiredString(body, "name"),
    startsAt: optionalString(body, "startsAt"),
    endsAt: optionalString(body, "endsAt"),
  };
}

function deployCommandInput(body: JsonObject): DeployCommandInput {
  const parsed = DeployCommandInputSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new HTTPException(StatusCodes.BAD_REQUEST, { message });
  }
  return parsed.data;
}

function checkpointInput(body: JsonObject): CheckpointInput {
  const points = body.points;
  if (!Number.isInteger(points) || Number(points) <= 0) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: "points must be a positive integer",
    });
  }
  return {
    problemId: requiredString(body, "problemId"),
    checkpointId: requiredString(body, "checkpointId"),
    flag: requiredString(body, "flag"),
    points: Number(points),
  };
}

export function createApp(options: AppOptions = {}): Hono<AppEnvironment> {
  const commandFetch = options.commandFetch ?? (fetch.bind(globalThis) as typeof fetch);
  const app = new Hono<AppEnvironment>();
  app.use("*", secureHeaders());
  app.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (context) =>
        context.json({ error: "request body too large" }, StatusCodes.REQUEST_TOO_LONG),
    }),
  );

  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message }, error.status);
    }
    console.error(
      JSON.stringify({
        event: "always-on.request.failed",
        path: context.req.path,
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return context.json({ error: "internal server error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  });

  app.get("/health", (context) =>
    context.json({ ok: true, service: "tenkacloud-always-on-control-plane" }),
  );
  app.get("/runtime-config.json", (context) =>
    context.json({
      apiBaseUrl: new URL(context.req.url).origin,
      auth: {
        provider: "auth0",
        issuer: context.env.AUTH0_ISSUER,
        audience: context.env.AUTH0_AUDIENCE,
        clientId: context.env.AUTH0_CLIENT_ID,
      },
    }),
  );

  // OIDC IdP surface (ADR-050): public documents AWS IAM fetches to validate the
  // command-path tokens exchanged via sts:AssumeRoleWithWebIdentity.
  app.get(OPENID_CONFIGURATION_PATH, (context) =>
    context.json(buildOpenIdConfiguration(new URL(context.req.url).origin)),
  );
  app.get(JWKS_PATH, async (context) =>
    context.json({ keys: [await publicJwkFromEnvironment(context.env)] }),
  );

  // MCP 2026-07-28 is deliberately split by role. Public author/developer
  // endpoints expose only deterministic, read-only material. Organizer and
  // participant endpoints reuse the same authentication boundaries as the
  // corresponding HTTP APIs; a client-supplied role can never expand access.
  app.post("/mcp/developer", (context) =>
    serveMcp(context.req.raw, context.env.CONTROL_DB, { role: "developer" }),
  );
  app.post("/mcp/problem-author", (context) =>
    serveMcp(context.req.raw, context.env.CONTROL_DB, { role: "problem-author" }),
  );

  app.get(ORGANIZER_MCP_RESOURCE_METADATA_PATH, (context) =>
    organizerMcpResourceMetadata(context.req.raw, context.env.AUTH0_ISSUER),
  );
  app.use("/mcp/organizer", async (context, next) => {
    await next();
    if (context.res.status === StatusCodes.UNAUTHORIZED) {
      context.res.headers.set(
        "WWW-Authenticate",
        organizerMcpAuthenticationChallenge(context.req.raw),
      );
    }
  });
  app.use("/mcp/organizer", options.organizerJwt ?? auth0JwtMiddleware());
  app.use("/mcp/organizer", options.organizerProjection ?? organizerProjectionMiddleware);
  app.post("/mcp/organizer", requireOrganizerRole(READING_ROLES), (context) =>
    serveMcp(context.req.raw, context.env.CONTROL_DB, {
      role: "organizer",
      organizer: context.get("organizer"),
    }),
  );

  app.use("/mcp/participant", options.teamAuth ?? teamBearerMiddleware);
  app.post("/mcp/participant", (context) =>
    serveMcp(context.req.raw, context.env.CONTROL_DB, {
      role: "participant",
      team: context.get("team"),
    }),
  );

  app.use("/v1/system/*", options.systemAuth ?? systemAdminMiddleware);

  // Onboard (or update) an Auth0 Organization -> tenant mapping the organizer auth path reads
  // on every request. `suspended: true` revokes access immediately (checked per request).
  app.put("/v1/system/tenant-auth-projections/:orgId", async (context) => {
    const orgId = context.req.param("orgId");
    if (orgId.trim().length === 0) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, { message: "orgId must be non-empty" });
    }
    const body = await readObject(context.req);
    const tenantId = requiredString(body, "tenantId");
    const rawSuspended = body.suspended;
    if (rawSuspended !== undefined && typeof rawSuspended !== "boolean") {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: "suspended must be a boolean",
      });
    }
    const store = new ControlStore(context.env.CONTROL_DB);
    await store.upsertTenantAuthProjection({
      orgId: orgId.trim(),
      tenantId,
      suspended: rawSuspended ?? false,
    });
    return context.body(null, StatusCodes.NO_CONTENT);
  });

  // Register (or update) a tenant-owned deployment account for the OIDC command
  // path (ADR-050). Deploy/destroy commands fail closed against this projection.
  app.put("/v1/system/competitor-accounts/:tenantId/:awsAccountId", async (context) => {
    const tenantId = context.req.param("tenantId").trim();
    if (tenantId.length === 0) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, { message: "tenantId must be non-empty" });
    }
    const awsAccountId = context.req.param("awsAccountId");
    if (!DEPLOY_AWS_ACCOUNT_ID_PATTERN.test(awsAccountId)) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: "awsAccountId must be a 12-digit AWS account id",
      });
    }
    const parsed = CompetitorAccountRegistrationSchema.safeParse(await readObject(context.req));
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new HTTPException(StatusCodes.BAD_REQUEST, { message });
    }
    const store = new ControlStore(context.env.CONTROL_DB);
    await store.upsertCompetitorAccountProjection({ tenantId, awsAccountId, ...parsed.data });
    return context.body(null, StatusCodes.NO_CONTENT);
  });

  app.use("/v1/runtime/*", options.runtimeAuth ?? runtimeFeedMiddleware);

  // Score feed: the AWS event runtime pushes each team's authoritative uptime points for an
  // event; the leaderboard sums these with the flag-materialized score_summary. Batched so one
  // scoring tick is one call.
  app.post("/v1/runtime/events/:eventId/score-summaries", async (context) => {
    const eventId = context.req.param("eventId");
    if (eventId.trim().length === 0) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, { message: "eventId must be non-empty" });
    }
    const body = await readObject(context.req);
    const rawScores = body.scores;
    if (!Array.isArray(rawScores) || rawScores.length === 0) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: "scores must be a non-empty array",
      });
    }
    if (rawScores.length > MAX_RUNTIME_SCORES_PER_REQUEST) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: `scores must not exceed ${MAX_RUNTIME_SCORES_PER_REQUEST} entries`,
      });
    }
    const scores = rawScores.map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: "each score must be an object",
        });
      }
      const record = entry as JsonObject;
      const points = record.points;
      if (
        !Number.isSafeInteger(points) ||
        Number(points) < MIN_RUNTIME_SCORE_POINTS ||
        Number(points) > MAX_RUNTIME_SCORE_POINTS
      ) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: `points must be a safe integer between ${MIN_RUNTIME_SCORE_POINTS} and ${MAX_RUNTIME_SCORE_POINTS}`,
        });
      }
      return { teamId: requiredString(record, "teamId"), points: Number(points) };
    });
    if (new Set(scores.map(({ teamId }) => teamId)).size !== scores.length) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: "scores must contain each teamId at most once",
      });
    }
    const store = new ControlStore(context.env.CONTROL_DB);
    if (!(await store.upsertRuntimeScores(eventId.trim(), scores))) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: "every score must reference a team in the event",
      });
    }
    return context.body(null, StatusCodes.NO_CONTENT);
  });

  app.use("/v1/admin/*", options.organizerJwt ?? auth0JwtMiddleware());
  app.use("/v1/admin/*", options.organizerProjection ?? organizerProjectionMiddleware);

  app.get("/v1/admin/events", requireOrganizerRole(READING_ROLES), async (context) => {
    const organizer = context.get("organizer");
    const store = new ControlStore(context.env.CONTROL_DB);
    return context.json({ items: await store.listEvents(organizer.tenantId) });
  });

  app.post("/v1/admin/events", requireOrganizerRole(MUTATING_ROLES), async (context) => {
    const organizer = context.get("organizer");
    const store = new ControlStore(context.env.CONTROL_DB);
    const event = await store.createEvent(
      organizer.tenantId,
      eventInput(await readObject(context.req)),
    );
    return context.json(event, StatusCodes.CREATED);
  });

  // Export a control-store scoring snapshot so an organizer can archive it before reconciliation
  // prunes a long-ended event. Per-tick runtime events remain an AWS-runtime archive concern.
  app.get(
    "/v1/admin/events/:eventId/export",
    requireOrganizerRole(READING_ROLES),
    async (context) => {
      const organizer = context.get("organizer");
      const eventId = context.req.param("eventId");
      const store = new ControlStore(context.env.CONTROL_DB);
      const scores = await store.exportEventScores(organizer.tenantId, eventId);
      if (scores === null) {
        throw new HTTPException(StatusCodes.NOT_FOUND, { message: "event not found" });
      }
      return context.json({ eventId, ...scores });
    },
  );

  app.post(
    "/v1/admin/events/:eventId/teams",
    requireOrganizerRole(MUTATING_ROLES),
    async (context) => {
      const organizer = context.get("organizer");
      const body = await readObject(context.req);
      const store = new ControlStore(context.env.CONTROL_DB);
      let team: { readonly teamId: string; readonly loginKey: string };
      try {
        team = await store.createTeam(
          organizer.tenantId,
          context.req.param("eventId"),
          requiredString(body, "displayName"),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "event not found") {
          throw new HTTPException(StatusCodes.NOT_FOUND, { message: error.message });
        }
        throw error;
      }
      // loginKey is intentionally exposed only by this one response.
      return context.json(team, StatusCodes.CREATED);
    },
  );

  app.put(
    "/v1/admin/events/:eventId/checkpoints",
    requireOrganizerRole(MUTATING_ROLES),
    async (context) => {
      const organizer = context.get("organizer");
      const store = new ControlStore(context.env.CONTROL_DB);
      try {
        await store.putCheckpoint(
          organizer.tenantId,
          context.req.param("eventId"),
          checkpointInput(await readObject(context.req)),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "event not found") {
          throw new HTTPException(StatusCodes.NOT_FOUND, { message: error.message });
        }
        throw error;
      }
      return context.body(null, StatusCodes.NO_CONTENT);
    },
  );

  app.post(
    "/v1/admin/events/:eventId/deploy-intents",
    requireOrganizerRole(MUTATING_ROLES),
    async (context) => {
      const organizer = context.get("organizer");
      const eventId = context.req.param("eventId");
      const input = deployCommandInput(await readObject(context.req));
      const store = new ControlStore(context.env.CONTROL_DB);
      if (!(await store.hasTeam(organizer.tenantId, eventId, input.teamId))) {
        throw new HTTPException(StatusCodes.NOT_FOUND, { message: "team not found" });
      }
      const gateway = commandGatewayFromEnvironment(context.env, commandFetch);
      const outcome = await executeDeployCommand(
        {
          ...input,
          tenantId: organizer.tenantId,
          eventId,
          // The issuer must equal the origin IAM registered as the OIDC provider.
          issuer: new URL(context.req.url).origin,
        },
        gateway,
        (tenantId, awsAccountId) => store.resolveCompetitorAccount(tenantId, awsAccountId),
      );
      if (!outcome.accepted) {
        console.error(
          JSON.stringify({
            event: "always-on.deploy-command.rejected",
            kind: outcome.kind,
            reason: outcome.reason,
          }),
        );
        // "rejected" = the organizer's command itself was refused (correctable
        // input/state, e.g. an unknown problemId or an unregistered account).
        // "gateway" = the STS exchange or the publish failed on the AWS side.
        return context.json(
          { error: "deploy command rejected", reason: outcome.reason },
          outcome.kind === "rejected" ? StatusCodes.UNPROCESSABLE_ENTITY : StatusCodes.BAD_GATEWAY,
        );
      }
      return context.json(
        { requestId: outcome.requestId, deploymentId: outcome.deploymentId },
        StatusCodes.ACCEPTED,
      );
    },
  );

  app.use("/v1/portal/*", options.teamAuth ?? teamBearerMiddleware);

  app.get("/v1/portal/me", (context) => {
    const team = context.get("team");
    return context.json({
      teamId: team.teamId,
      eventId: team.eventId,
      displayName: team.displayName,
    });
  });

  app.get("/v1/portal/events/:eventId/leaderboard", async (context) => {
    const team = context.get("team");
    const eventId = context.req.param("eventId");
    if (team.eventId !== eventId) {
      throw new HTTPException(StatusCodes.NOT_FOUND, { message: "event not found" });
    }
    const store = new ControlStore(context.env.CONTROL_DB);
    return context.json({ items: await store.leaderboard(eventId) });
  });

  app.post("/v1/portal/flags", async (context) => {
    const team = context.get("team");
    const body = await readObject(context.req);
    const eventId = requiredString(body, "eventId");
    if (team.eventId !== eventId) {
      throw new HTTPException(StatusCodes.NOT_FOUND, { message: "event not found" });
    }
    const store = new ControlStore(context.env.CONTROL_DB);
    const result = await store.submitCheckpoint({
      teamId: team.teamId,
      eventId,
      problemId: requiredString(body, "problemId"),
      checkpointId: requiredString(body, "checkpointId"),
      flag: requiredString(body, "flag"),
    });
    return context.json(
      { result },
      result === "incorrect" ? StatusCodes.UNPROCESSABLE_ENTITY : StatusCodes.OK,
    );
  });

  return app;
}
