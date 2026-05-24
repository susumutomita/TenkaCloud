import type { Context, Handler } from "hono";
import { StatusCodes } from "http-status-codes";
import type { z } from "zod";
import { requireRole } from "../deploy-handler/auth.js";
import { ULID_RE as EVENT_ID_RE } from "../shared/constants.js";
import { isEventOwnedByTenant } from "./disruption-fire.js";
import type { EventSharedResources } from "./shared.js";

type RouteResult = Response | Promise<Response>;

export const LIST_LIMIT_MAX = 200;

/**
 * Parse a `limit` query string. Returns `null` if it is present but invalid
 * (so the caller can return a 400), and `{ ok: true, limit: undefined }` when
 * unspecified (so the downstream service applies its own default).
 */
export function parseLimit(
  value: string | undefined,
): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

interface RouteContext {
  readonly c: Context;
}

interface EventRouteContext extends RouteContext {
  readonly eventId: string;
}

interface JsonRouteContext<TBody> extends RouteContext {
  readonly body: TBody;
}

interface RouteOptions {
  readonly roles?: readonly string[];
}

type ParseResult<TBody> =
  | { readonly ok: true; readonly data: TBody }
  | { readonly ok: false; readonly response: Response };

export function withEventId(
  handler: (ctx: EventRouteContext) => RouteResult,
  options: RouteOptions = {},
): Handler {
  return (c) => {
    applyRouteRole(c, options);
    const parsed = parseEventId(c);
    if (!parsed.ok) return parsed.response;
    return handler({ c, eventId: parsed.data });
  };
}

export function withJsonBody<TSchema extends z.ZodType>(
  schema: TSchema,
  handler: (ctx: JsonRouteContext<z.infer<TSchema>>) => RouteResult,
  options: RouteOptions = {},
): Handler {
  return async (c) => {
    applyRouteRole(c, options);
    const parsed = await parseJsonBody(c, schema);
    if (!parsed.ok) return parsed.response;
    return handler({ c, body: parsed.data });
  };
}

export async function parseJsonBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<ParseResult<z.infer<TSchema>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST) };
  }
  return parseSchemaBody(c, schema, body);
}

export async function parseOptionalJsonBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<ParseResult<z.infer<TSchema>>> {
  let body: unknown = {};
  const raw = await c.req.text().catch(() => "");
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, response: c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST) };
    }
  }
  return parseSchemaBody(c, schema, body);
}

export function handleRouteError(
  c: Context,
  logMessage: string,
  fields: Record<string, unknown>,
  err: unknown,
): Response {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error(logMessage, { ...fields, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
}

export async function requireEventOwnership(args: {
  readonly c: Context;
  readonly shared: EventSharedResources;
  readonly eventId: string;
  readonly tenantId: string;
}): Promise<Response | undefined> {
  const { c, shared, eventId, tenantId } = args;
  if (await isEventOwnedByTenant(shared, eventId, tenantId)) return undefined;
  return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
}

function applyRouteRole(c: Context, options: RouteOptions): void {
  if (options.roles) requireRole(c, options.roles);
}

function parseEventId(c: Context): ParseResult<string> {
  const eventId = c.req.param("eventId");
  if (eventId && EVENT_ID_RE.test(eventId)) {
    return { ok: true, data: eventId };
  }
  return { ok: false, response: c.json({ error: "invalid_event_id" }, StatusCodes.BAD_REQUEST) };
}

function parseSchemaBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
  body: unknown,
): ParseResult<z.infer<TSchema>> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    ),
  };
}
