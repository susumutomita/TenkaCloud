// Deep imports (not the barrel) so the Worker never pulls the browser-only
// Cognito redirect helpers — those reference `window`, which is absent from the
// Worker's TS lib. These two modules are pure WebCrypto and Worker-safe.
import { createCachingJwksResolver } from "@tenkacloud/auth-client/jwks-resolver";
import { type JwksResolver, verifyOidcJwt } from "@tenkacloud/auth-client/oidc-jwks-verify";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";
import { sha256Hex } from "./crypto.js";
import type { AppEnvironment, OrganizerContext, TeamContext } from "./types.js";

type JsonObject = Record<string, unknown>;

const jwksResolvers = new Map<string, JwksResolver>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredClaim(payload: JsonObject, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HTTPException(StatusCodes.UNAUTHORIZED, {
      message: `missing token claim: ${name}`,
    });
  }
  return value;
}

interface Auth0JwtMiddlewareOverrides {
  readonly fetchImpl?: typeof fetch;
}

export function auth0JwtMiddleware(
  overrides?: Auth0JwtMiddlewareOverrides,
): MiddlewareHandler<AppEnvironment> {
  const fetchImpl = overrides?.fetchImpl ?? globalThis.fetch;
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
    if (!match?.[1]) {
      throw new HTTPException(StatusCodes.UNAUTHORIZED, {
        message: "missing or malformed access token",
      });
    }

    const jwksUri = `${context.env.AUTH0_ISSUER.replace(/\/+$/u, "")}/.well-known/jwks.json`;
    let jwksResolver = jwksResolvers.get(jwksUri);
    if (!jwksResolver) {
      jwksResolver = createCachingJwksResolver({ jwksUri, fetchImpl });
      jwksResolvers.set(jwksUri, jwksResolver);
    }

    const outcome = await verifyOidcJwt(match[1], {
      jwksResolver,
      issuer: context.env.AUTH0_ISSUER,
      audience: context.env.AUTH0_AUDIENCE,
    });
    if (!outcome.valid) {
      throw new HTTPException(StatusCodes.UNAUTHORIZED, {
        message: "invalid access token",
      });
    }

    context.set("jwtPayload", outcome.claims);
    await next();
  };
}

/**
 * Resolves Auth0 Organization → tenant and checks suspension on every request.
 * Suspension is deliberately not trusted from a long-lived JWT.
 */
export const organizerProjectionMiddleware = createMiddleware<AppEnvironment>(
  async (context, next) => {
    const rawPayload: unknown = context.get("jwtPayload");
    if (!isObject(rawPayload)) {
      throw new HTTPException(StatusCodes.UNAUTHORIZED, {
        message: "invalid access token payload",
      });
    }
    const subject = requiredClaim(rawPayload, "sub");
    const organizationId = requiredClaim(rawPayload, "org_id");
    const rawRoles = rawPayload[context.env.AUTH0_ROLES_CLAIM];
    const roles = Array.isArray(rawRoles)
      ? rawRoles.filter((role): role is string => typeof role === "string")
      : [];

    const projection = await context.env.CONTROL_DB.prepare(
      "SELECT tenant_id, suspended FROM tenant_auth_projection WHERE org_id = ?",
    )
      .bind(organizationId)
      .first<{ tenant_id: string; suspended: number }>();
    if (!projection) {
      throw new HTTPException(StatusCodes.FORBIDDEN, {
        message: "organization is not mapped to a tenant",
      });
    }
    if (projection.suspended === 1) {
      throw new HTTPException(StatusCodes.FORBIDDEN, { message: "tenant is suspended" });
    }
    context.set("organizer", {
      subject,
      organizationId,
      tenantId: projection.tenant_id,
      roles,
    });
    await next();
  },
);

export function requireOrganizerRole(
  allowedRoles: readonly string[],
): MiddlewareHandler<AppEnvironment> {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    const organizer = context.get("organizer");
    if (!allowedRoles.some((role) => organizer.roles.includes(role))) {
      throw new HTTPException(StatusCodes.FORBIDDEN, { message: "insufficient role" });
    }
    await next();
  });
}

export const teamBearerMiddleware = createMiddleware<AppEnvironment>(async (context, next) => {
  const authorization = context.req.header("authorization");
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  if (!match?.[1]) {
    throw new HTTPException(StatusCodes.UNAUTHORIZED, {
      message: "missing team bearer token",
    });
  }
  const loginKeyHash = await sha256Hex(match[1]);
  const team = await context.env.CONTROL_DB.prepare(
    `SELECT teams.team_id, teams.event_id, teams.display_name,
            tenant_auth_projection.suspended
       FROM teams
       LEFT JOIN tenant_auth_projection
         ON tenant_auth_projection.tenant_id = teams.tenant_id
      WHERE teams.login_key_hash = ?`,
  )
    .bind(loginKeyHash)
    .first<{
      team_id: string;
      event_id: string;
      display_name: string;
      suspended: number | null;
    }>();
  if (!team) {
    throw new HTTPException(StatusCodes.UNAUTHORIZED, {
      message: "invalid team bearer token",
    });
  }
  if (team.suspended !== 0) {
    throw new HTTPException(StatusCodes.FORBIDDEN, { message: "tenant is suspended" });
  }
  context.set("team", {
    teamId: team.team_id,
    eventId: team.event_id,
    displayName: team.display_name,
  });
  await next();
});

export function organizerForTest(input: OrganizerContext): MiddlewareHandler<AppEnvironment> {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    context.set("organizer", input);
    await next();
  });
}

export function teamForTest(input: TeamContext): MiddlewareHandler<AppEnvironment> {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    context.set("team", input);
    await next();
  });
}
