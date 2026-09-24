import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ULID_RE } from "../shared/constants.js";
import {
  claimRegistration,
  inspectRegistration,
  RegistrationError,
  registrationDigest,
  registrationStatus,
} from "../shared/event-registration.js";
import { participantRateLimiter, RATE_LIMITS } from "../shared/rate-limiter.js";
import { extractBearerToken } from "./auth.js";
import { type ParticipantSharedResources, resolveDeploymentsRepository } from "./shared.js";

const pathSchema = z.object({
  tenantId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  eventId: z.string().regex(ULID_RE),
});
const claimSchema = z.object({ receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export function registerPublicRegistrationRoutes(app: Hono, shared: ParticipantSharedResources) {
  const base = "/portal/registration/:tenantId/:eventId/:action";
  app.post(base, bodyLimit({ maxSize: 1024 }), async (c) => {
    const params = pathSchema.safeParse(c.req.param());
    const token = extractBearerToken(c.req.header("Authorization"));
    const action = c.req.param("action");
    if (!params.success || !token || !["info", "claim", "status"].includes(action)) {
      return c.json({ error: "not_found" }, 404);
    }
    const limit = participantRateLimiter.take(
      `registration:${action}:${registrationDigest(token)}`,
      // One invitation is shared by the entire event (up to 99 team slots).
      action === "status" ? RATE_LIMITS.READ_MID : { capacity: 100, refillPerSec: 2 },
    );
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSec));
      return c.json({ error: "rate_limited" }, 429);
    }
    try {
      return await executeRegistration(c, shared, params.data, token, action);
    } catch (error) {
      return registrationFailure(c, error);
    }
  });
}

async function executeRegistration(
  c: Context,
  shared: ParticipantSharedResources,
  params: z.infer<typeof pathSchema>,
  token: string,
  action: string,
) {
  const repositories = await shared.runtime.resolveRepositories({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
    teamsTableName: shared.teamsTableName ?? "",
  });
  const deps = { ...repositories, deployments: await resolveDeploymentsRepository(shared) };
  const { tenantId, eventId } = params;
  if (action === "info") return c.json(await inspectRegistration(deps, tenantId, eventId, token));
  if (action === "status") return c.json(await registrationStatus(deps, tenantId, eventId, token));
  const body = claimSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  return c.json(await claimRegistration(deps, tenantId, eventId, token, body.data.receipt));
}

function registrationFailure(c: Context, error: unknown) {
  if (error instanceof RegistrationError)
    return c.json({ error: error.code }, error.code === "not_found" ? 404 : 409);
  console.error("[registration] operation failed", {
    name: error instanceof Error ? error.name : "unknown",
  });
  return c.json({ error: "registration_unavailable" }, 503);
}
