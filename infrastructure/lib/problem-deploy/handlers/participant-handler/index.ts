import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_ERROR,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
} from "../shared/http-status.js";
import { extractBearerToken } from "./auth.js";
import { lookupByTeamLoginKey } from "./lookup.js";
import { buildParticipantSharedResources } from "./shared.js";
import { submitFlag } from "./submit-flag.js";
import { setDisplayTeamName } from "./update.js";

/**
 * Participant Portal backend Lambda の Hono app。routes:
 *   GET   /portal/healthz
 *   GET   /portal/me                — Authorization: Bearer <teamLoginKey>
 *   PATCH /portal/me                — body: { teamName: string }
 *   POST  /portal/me/submit-flag    — body: { flag: string }
 *
 * Function URL は `AuthType=NONE` で公開し、`teamLoginKey` 自体を bearer として
 * Lambda 内で検証する。
 */
const shared = buildParticipantSharedResources();
const app = new Hono();

app.get("/portal/healthz", (c) => c.json({ ok: true }));

app.get("/portal/me", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  try {
    const view = await lookupByTeamLoginKey(shared, token);
    if (!view) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    return c.json(view, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] lookup failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.patch("/portal/me", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
  }
  const teamName = (body as { teamName?: unknown })?.teamName;
  try {
    const outcome = await setDisplayTeamName(shared, token, teamName);
    if (outcome.kind === "invalid_team_name") {
      return c.json({ error: "invalid_team_name" }, HTTP_BAD_REQUEST);
    }
    if (outcome.kind === "unauthorized") {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    }
    return c.json(outcome.view, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] update failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.post("/portal/me/submit-flag", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, HTTP_BAD_REQUEST);
  }
  const flag = (body as { flag?: unknown })?.flag;
  if (typeof flag !== "string" || flag.length === 0 || flag.length > 200) {
    return c.json({ error: "invalid_flag" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await submitFlag(shared, shared.problemsScoring, token, flag);
    if (outcome.kind === "unauthorized")
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    if (outcome.kind === "not_flag_problem") {
      return c.json({ error: "not_flag_problem" }, HTTP_BAD_REQUEST);
    }
    if (outcome.kind === "no_outputs") return c.json({ error: "no_outputs" }, HTTP_BAD_REQUEST);
    return c.json(outcome, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] submitFlag failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
