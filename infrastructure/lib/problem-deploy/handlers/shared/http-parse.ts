import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import type { z } from "zod";

/**
 * Issue #2211: one implementation of the HTTP request-boundary parsing that the
 * participant / event (and, in follow-ups, competitor-accounts / deploy) handlers
 * each copied. The JSON-parse-then-Zod-validate boundary was duplicated across
 * handlers, and the error responses had already drifted subtly between them.
 *
 * The response *shapes* are the frozen contract the frontend depends on (pinned by
 * the #2196 shape tests) and are unchanged here:
 *   - JSON parse failure        → `{ error: "invalid_body" }`            (400)
 *   - Zod validation failure    → `{ error: "validation_failed", issues }` (400)
 * `issues` is `ZodError.issues` verbatim, exactly as both handlers emitted it.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: Response };

/** `{ error: "invalid_body" }` (400) — a body that is not parseable JSON. */
function invalidBody(c: Context): Response {
  return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
}

/** Validate an already-decoded value against a Zod schema, emitting the frozen shapes. */
export function parseSchema<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
  value: unknown,
): ParseResult<z.infer<TSchema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    ),
  };
}

/** Parse a required JSON body and validate it. Missing/invalid JSON → `invalid_body`. */
export async function parseJsonBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<ParseResult<z.infer<TSchema>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: invalidBody(c) };
  }
  return parseSchema(c, schema, body);
}

/**
 * Parse an OPTIONAL JSON body: an empty request body is treated as `{}` (so a schema
 * whose fields are all optional accepts it), while a non-empty malformed body is
 * still `invalid_body`. Mirrors the event handler's previous `parseOptionalJsonBody`.
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
      return { ok: false, response: invalidBody(c) };
    }
  }
  return parseSchema(c, schema, body);
}

/** Validate the query string (`c.req.query()`) against a schema. */
export function parseQuery<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): ParseResult<z.infer<TSchema>> {
  return parseSchema(c, schema, c.req.query());
}

/** Validate the path params (`c.req.param()`) against a schema. */
export function parseParams<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): ParseResult<z.infer<TSchema>> {
  return parseSchema(c, schema, c.req.param());
}
