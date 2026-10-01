import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import { contentDigest, DeploymentConflict } from "../../control-data/domain/deployment-work.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import { ApiError, type OrganizerAuthConfig, participantKey, requireOrganizer } from "./auth.js";
import { type CloudConnectionApi, registerCloudConnectionRoutes } from "./connection-routes.js";
import { type CloudDeploymentApi, registerCloudDeploymentRoutes } from "./deployment-routes.js";
import { registerCloudScheduleRoutes } from "./schedule-routes.js";
import { body, createEventSchema, identifier } from "./schema.js";
import { eventSummary, leaderboard, participantView, teamSummary } from "./views.js";

export interface CloudApiOptions {
  readonly repository: CloudRepository;
  readonly organizerAuth: OrganizerAuthConfig;
  readonly allowedOrigins: readonly string[];
  readonly now?: () => number;
  readonly deployment?: CloudDeploymentApi;
  readonly connections?: CloudConnectionApi;
}
const readRoles = ["Admin", "Operator", "Viewer"] as const;
const writeRoles = ["Admin", "Operator"] as const;
async function eventOr404(repo: CloudRepository, id: string): Promise<EventRecord> {
  const event = await repo.getEvent(identifier.parse(id));
  if (!event) throw new ApiError(404, "not_found");
  return event;
}
async function authenticate(
  repo: CloudRepository,
  context: Context,
  now: number,
): Promise<TeamRecord> {
  const key = participantKey(context.req.header("Authorization"));
  const team = await repo.authenticateTeam(key, now);
  if (!team) throw new ApiError(401, "unauthorized");
  return team;
}
async function create(
  repo: CloudRepository,
  context: Context,
  now: number,
  auth: OrganizerAuthConfig,
) {
  const actor = requireOrganizer(context, writeRoles, auth, now);
  const input = createEventSchema.parse(await body(context));
  const requestKey = z
    .string()
    .min(1)
    .max(255)
    .parse(context.req.header("Idempotency-Key") ?? ulid());
  context.header("Idempotency-Key", requestKey);
  const requestHash = contentDigest(JSON.stringify(input));
  const prior = await repo.replayEventCreation(actor.sub, requestKey, requestHash);
  if (prior !== undefined) return context.json(prior, 201);
  const eventId = ulid(now);
  const createdAt = new Date(now).toISOString();
  const expiresAt = Math.floor(now / 1000) + 7 * 86400;
  const teams: TeamRecord[] = input.teams.map((team) => ({
    ...team,
    eventId,
    teamId: ulid(),
    teamLoginKey: randomBytes(32).toString("base64url"),
    authVersion: 1,
    accessRevoked: false,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  }));
  const event: EventRecord = {
    eventId,
    name: input.name,
    problems: input.problems,
    teamCount: teams.length,
    status: "DRAFT",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };
  const response = {
    eventId,
    status: event.status,
    createdAt,
    expiresAt,
    teams: teams.map((team) => ({
      teamId: team.teamId,
      internalSlug: team.internalSlug,
      teamLoginKey: team.teamLoginKey,
    })),
    problems: input.problems,
  };
  if (
    (await repo.createEventWithTeams(event, teams, {
      scope: actor.sub,
      key: requestKey,
      requestHash,
      response,
    })) !== "created"
  ) {
    const winner = await repo.replayEventCreation(actor.sub, requestKey, requestHash);
    if (winner !== undefined) return context.json(winner, 201);
    throw new ApiError(409, "creation_conflict");
  }
  return context.json(response, 201);
}
async function detail(
  repo: CloudRepository,
  context: Context,
  now: number,
  auth: OrganizerAuthConfig,
) {
  requireOrganizer(context, readRoles, auth, now);
  const reveal = context.req.query("withTeamLoginKeys") === "true";
  if (reveal) requireOrganizer(context, writeRoles, auth, now);
  const event = await eventOr404(repo, context.req.param("eventId") ?? "");
  const [teams, deployments] = await Promise.all([
    repo.listTeamsByEvent(event.eventId),
    repo.listDeploymentsByEvent(event.eventId),
  ]);
  const deploymentsByProblem: Record<string, { jobId: string; teamId: string; status: string }[]> =
    {};
  for (const job of deployments) {
    if (job.eventId !== event.eventId) throw new Error("Deployment scope mismatch.");
    const group = deploymentsByProblem[job.problemId] ?? [];
    deploymentsByProblem[job.problemId] = group;
    group.push({
      jobId: job.jobId,
      teamId: job.teamId,
      status: job.status,
    });
  }
  return context.json({
    ...eventSummary(event),
    problems: event.problems,
    teams: teams.map((team) => teamSummary(team, reveal)),
    deploymentsByProblem,
  });
}
async function changeAccess(
  repo: CloudRepository,
  context: Context,
  now: number,
  revoke: boolean,
  auth: OrganizerAuthConfig,
) {
  requireOrganizer(context, revoke ? ["Admin"] : writeRoles, auth, now);
  const event = await eventOr404(repo, context.req.param("eventId") ?? "");
  const teamId = identifier.parse(context.req.param("teamId"));
  const team = await repo.getTeam(event.eventId, teamId);
  if (!team) throw new ApiError(404, "not_found");
  const key = revoke ? undefined : randomBytes(32).toString("base64url");
  const at = new Date(now).toISOString();
  if ((await repo.rotateTeamAccess(team, key, at)) !== "updated")
    throw new ApiError(409, "rotation_conflict");
  return context.json(
    key
      ? { kind: "ok", teamId, teamLoginKey: key, rotatedAt: at }
      : { kind: "ok", teamId, revokedAt: at },
  );
}
/** Reuses the old HTTP routes and Cognito-authorizer boundary; unsupported runner routes stay absent. */
export function createCloudApp(options: CloudApiOptions): Hono {
  const repo = options.repository;
  const now = options.now ?? Date.now;
  if (!options.organizerAuth.issuer.startsWith("https://") || !options.organizerAuth.audience)
    throw new Error("Explicit Cognito issuer and audience are required.");
  const app = new Hono();
  app.use("*", async (context, next) => {
    const origin = context.req.header("Origin");
    if (origin && !options.allowedOrigins.includes(origin))
      throw new ApiError(403, "forbidden_origin");
    if (origin) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
      context.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key");
      context.header("Access-Control-Expose-Headers", "Idempotency-Key");
      context.header("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
    }
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
    return undefined;
  });
  app.onError((error, context) => {
    if (error instanceof ApiError) return context.json({ error: error.code }, error.status);
    if (error instanceof DeploymentConflict)
      return context.json(
        { error: error.code },
        error.code === "idempotency_key_reused" ? 422 : 409,
      );
    if (error instanceof z.ZodError) return context.json({ error: "invalid_request" }, 400);
    console.error("[cloud-api] request failed", error.name);
    return context.json({ error: "internal_error" }, 500);
  });
  app.get("/events", async (context) => {
    requireOrganizer(context, readRoles, options.organizerAuth, now());
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(context.req.query("limit") ?? 50);
    const events = await repo.listEvents();
    const cursor = context.req.query("cursor");
    const previous = cursor
      ? events.findIndex((event) => event.eventId === identifier.parse(cursor))
      : -1;
    if (cursor && previous < 0) throw new ApiError(400, "invalid_cursor");
    const page = events.slice(previous + 1, previous + 1 + limit);
    const last = page.at(-1);
    return context.json({
      items: page.map(eventSummary),
      ...(last && previous + 1 + page.length < events.length ? { nextCursor: last.eventId } : {}),
    });
  });
  app.post("/events", (context) => create(repo, context, now(), options.organizerAuth));
  app.get("/events/:eventId", (context) => detail(repo, context, now(), options.organizerAuth));
  app.post("/events/:eventId/teams/:teamId/rotate-login-key", (context) =>
    changeAccess(repo, context, now(), false, options.organizerAuth),
  );
  app.delete("/events/:eventId/teams/:teamId/access", (context) =>
    changeAccess(repo, context, now(), true, options.organizerAuth),
  );
  app.get("/portal/me", async (context) => {
    const team = await authenticate(repo, context, now());
    return context.json(
      participantView(team, await repo.listDeploymentsByTeam(team.eventId, team.teamId)),
    );
  });
  app.get("/portal/leaderboard", async (context) => {
    const team = await authenticate(repo, context, now());
    const event = await eventOr404(repo, team.eventId);
    const [teams, scores] = await Promise.all([
      repo.listTeamsByEvent(event.eventId),
      repo.listTeamScores(event.eventId),
    ]);
    return context.json(leaderboard(event, teams, scores, team.teamId, now()));
  });
  if (options.deployment)
    registerCloudDeploymentRoutes(app, {
      ...options.deployment,
      repository: repo,
      organizerAuth: options.organizerAuth,
      now,
    });
  if (options.deployment)
    registerCloudScheduleRoutes(app, {
      repository: repo,
      work: options.deployment.work,
      organizerAuth: options.organizerAuth,
      now,
    });
  if (options.connections && options.deployment)
    registerCloudConnectionRoutes(app, {
      ...options.connections,
      repository: repo,
      work: options.deployment.work,
      organizerAuth: options.organizerAuth,
      now,
    });
  return app;
}
