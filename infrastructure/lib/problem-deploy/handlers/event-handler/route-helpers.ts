import type { Context, Handler } from "hono";
import { StatusCodes } from "http-status-codes";
import type { z } from "zod";
import { requireRole, requireTenantNotSuspended } from "../deploy-handler/auth.js";
import { ULID_RE as EVENT_ID_RE } from "../shared/constants.js";
import { parseJsonBody } from "../shared/http-parse.js";
import { isEventOwnedByTenant } from "./disruption-fire.js";
import type { EventSharedResources } from "./shared.js";

// Issue #2211: JSON body の parse + Zod 検証 + 標準 400 整形は shared/http-parse.ts に集約。
// event-handler の既存 import 経路 (routes/*, tests) を保つため re-export する。
export { parseJsonBody };

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
  readonly rejectSuspendedTenant?: boolean;
}

type ParseResult<TBody> =
  | { readonly ok: true; readonly data: TBody }
  | { readonly ok: false; readonly response: Response };

export function withEventId(
  handler: (ctx: EventRouteContext) => RouteResult,
  options: RouteOptions = {},
): Handler {
  return (c) => {
    applyRouteGuards(c, options);
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
    applyRouteGuards(c, options);
    const parsed = await parseJsonBody(c, schema);
    if (!parsed.ok) return parsed.response;
    return handler({ c, body: parsed.data });
  };
}

/**
 * Issue #2211: body が省略可能な route 用の parse。空 body は `{}` として schema に通し
 * (default 値の適用を許す)、非空だけ JSON parse する。`c.req.json()` を無条件に呼ぶ shared
 * `parseJsonBody` とは parse 段が異なるため個別実装のまま残すが、`invalid_body` /
 * `validation_failed` の応答形状は shared と同一。
 */
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

function applyRouteGuards(c: Context, options: RouteOptions): void {
  if (options.roles) requireRole(c, options.roles);
  if (options.rejectSuspendedTenant) requireTenantNotSuspended(c);
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
