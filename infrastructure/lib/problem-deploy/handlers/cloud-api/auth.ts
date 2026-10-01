import type { Context } from "hono";

export interface OrganizerAuthConfig {
  readonly issuer: string;
  readonly audience: string;
}

export type OrganizerRole = "Admin" | "Operator" | "Viewer";
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}
/** API Gateway verifies the Cognito signature/audience before invoking the organizer routes. */
export function requireOrganizer(
  context: Context,
  roles: readonly OrganizerRole[],
  expected: OrganizerAuthConfig,
  now: number,
): { sub: string; role: OrganizerRole } {
  const env = context.env as
    | {
        event?: {
          requestContext?: {
            authorizer?: {
              claims?: Record<string, unknown>;
              jwt?: { claims?: Record<string, unknown> };
            };
          };
        };
      }
    | undefined;
  const authorizer = env?.event?.requestContext?.authorizer;
  const claims = authorizer?.jwt?.claims ?? authorizer?.claims;
  if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.token_use !== "id")
    throw new ApiError(401, "unauthorized");
  if (
    claims.iss !== expected.issuer ||
    claims.aud !== expected.audience ||
    !Number.isFinite(Number(claims.exp)) ||
    Number(claims.exp) <= Math.floor(now / 1000)
  )
    throw new ApiError(401, "unauthorized");
  const role = claims["custom:userRole"];
  if (role !== "Admin" && role !== "Operator" && role !== "Viewer")
    throw new ApiError(403, "forbidden_role");
  if (!roles.includes(role)) throw new ApiError(403, "forbidden_role");
  return { sub: claims.sub, role };
}
/** Restored participant key shape from participant-handler/auth.ts. No JWT decoding fallback. */
export function participantKey(authorization: string | undefined): string {
  const match = /^Bearer ([a-z0-9_-]{43})$/iu.exec(authorization ?? "");
  if (!match?.[1]) throw new ApiError(401, "unauthorized");
  return match[1];
}
