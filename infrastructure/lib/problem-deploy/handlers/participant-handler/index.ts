import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { extractBearerToken } from "./auth.js";
import { lookupByTeamLoginKey } from "./lookup.js";
import { buildParticipantSharedResources } from "./shared.js";

/**
 * Participant Portal backend Lambda の Hono app。routes:
 *   GET /portal/healthz
 *   GET /portal/me   — Authorization: Bearer <teamLoginKey>
 *
 * Function URL は `AuthType=NONE` で公開し、`teamLoginKey` 自体を bearer として
 * Lambda 内で検証する (Cognito を介さない)。teamLoginKey は POST /problems/:id/deploy
 * のレスポンスで 1 度だけ露出する 24 文字 base64url の短命キー。
 */
const shared = buildParticipantSharedResources();
const app = new Hono();

app.get("/portal/healthz", (c) => c.json({ ok: true }));

app.get("/portal/me", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const view = await lookupByTeamLoginKey(shared, token);
    if (!view) return c.json({ error: "unauthorized" }, 401);
    return c.json(view, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] lookup failed", { message });
    return c.json({ error: "internal_error" }, 500);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
