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
  teamBearerMiddleware,
} from "./auth.js";
import { type CheckpointInput, ControlStore, type EventInput } from "./store.js";
import type { AppEnvironment } from "./types.js";

const MUTATING_ROLES = ["TenantAdmin", "TenantOperator"] as const;
const READING_ROLES = [...MUTATING_ROLES, "TenantViewer"] as const;

interface AppOptions {
  readonly organizerJwt?: MiddlewareHandler<AppEnvironment>;
  readonly organizerProjection?: MiddlewareHandler<AppEnvironment>;
  readonly teamAuth?: MiddlewareHandler<AppEnvironment>;
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
