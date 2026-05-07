import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { PROBLEM_ID_RE } from "../shared/constants.js";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
} from "../shared/http-status.js";
import { extractBearerToken } from "./auth.js";
import { getLeaderboard } from "./leaderboard.js";
import { lookupTeamByLoginKey } from "./lookup.js";
import { listScoreEvents } from "./score-events.js";
import { buildParticipantSharedResources } from "./shared.js";
import { getConsoleSigninUrl } from "./sso.js";
import { submitFlag } from "./submit-flag.js";
import { setDisplayTeamName } from "./update.js";

/**
 * Participant Portal backend Lambda の Hono app (Phase 2c で team scope)。routes:
 *   GET   /portal/healthz
 *   GET   /portal/leaderboard       — event scope の team ランキング
 *   GET   /portal/me/score-events   — 自チームの加点履歴 (時系列降順)
 *   GET   /portal/me                — Authorization: Bearer <teamLoginKey>
 *                                     → { team, problems[] }
 *   PATCH /portal/me                — body: { teamName: string } (team の全行を update)
 *   POST  /portal/me/submit-flag    — body: { problemId: string, flag: string }
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
    const view = await lookupTeamByLoginKey(shared, token);
    if (!view) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    return c.json(view, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] lookup failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/portal/me/score-events", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  try {
    const outcome = await listScoreEvents(shared, token);
    if (outcome.kind === "unauthorized") {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    }
    return c.json(outcome.response, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] score-events failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/portal/me/console-signin-url", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  const jobId = c.req.query("jobId");
  if (!jobId) return c.json({ error: "missing_jobid" }, HTTP_BAD_REQUEST);
  try {
    const outcome = await getConsoleSigninUrl(shared, token, jobId);
    if (outcome.kind === "unauthorized") {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    }
    if (outcome.kind === "invalid_jobid") {
      return c.json({ error: "invalid_jobid" }, HTTP_BAD_REQUEST);
    }
    if (outcome.kind === "not_ready") {
      return c.json({ error: "not_ready" }, HTTP_BAD_REQUEST);
    }
    if (outcome.kind === "misconfigured") {
      return c.json({ error: "misconfigured" }, HTTP_INTERNAL_ERROR);
    }
    return c.json({ loginUrl: outcome.loginUrl }, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] sso failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/portal/leaderboard", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  try {
    const outcome = await getLeaderboard(shared, token);
    if (outcome.kind === "unauthorized") {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    }
    if (outcome.kind === "no_event") {
      // Phase 1 以前 / 旧 jobId-based deployment は event scope の leaderboard 不可
      return c.json({ error: "no_event" }, HTTP_NOT_FOUND);
    }
    return c.json(outcome.response, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[portal] leaderboard failed", { message });
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
  const problemId = (body as { problemId?: unknown })?.problemId;
  const flag = (body as { flag?: unknown })?.flag;
  if (typeof problemId !== "string" || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid_problem_id" }, HTTP_BAD_REQUEST);
  }
  if (typeof flag !== "string" || flag.length === 0 || flag.length > 200) {
    return c.json({ error: "invalid_flag" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await submitFlag(shared, shared.problemsScoring, token, problemId, flag);
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
