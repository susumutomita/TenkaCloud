import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import {
  HTTP_ACCEPTED,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
} from "../shared/http-status.js";
import { resolveTenantId } from "./auth.js";
import { requestTeardown } from "./delete.js";
import {
  buildContext,
  buildSharedResources,
  startDeployment,
  UnknownProblemError,
} from "./deploy.js";
import { getDeployment, listDeployments } from "./list.js";
import { DeployRequestSchema } from "./types.js";

/**
 * Deploy API Lambda の Hono app。routes:
 *   POST   /problems/:problemId/deploy
 *   GET    /problems/:problemId/deployments
 *   GET    /deployments/:jobId
 *   DELETE /deployments/:jobId
 *
 * Auth: 本番経路は API Gateway HTTP API + Cognito JWT authorizer で、tenantId は
 * JWT の `custom:tenantId` claim から取り出す。Function URL (AWS_IAM) は ops 用に
 * 残しており、その経路では `DEFAULT_TENANT_ID` env にフォールバック。
 */

// problemId は metadata.json と整合する RFC 1035-ish の slug。両端は英数字、内側のみハイフン許容。
const PROBLEM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // ULID
const LIST_LIMIT_MAX = 200;

// SDK clients / env を module scope で 1 度だけ build。warm invoke で connection pool 再利用。
const shared = buildSharedResources();

/** `?limit=` query を parse し、不正なら null + 400 レスポンスを返す。 */
function parseLimit(value: string | undefined): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

const app = new Hono();

// CORS は本 Lambda 側で打つ (= API Gateway の defaultCorsPreflightOptions は OPTIONS のみ
// 対応で、実 POST/GET レスポンスには Access-Control-Allow-Origin が付かないため)。
// Cognito JWT は Authorization header で送られるので credentials cookie は使わず、`*`
// で許可する。Phase 2 で tenant の CloudFront URL に絞る。
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/problems/:problemId/deploy", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid problemId" }, HTTP_BAD_REQUEST);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, HTTP_BAD_REQUEST);
  }

  const parsed = DeployRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, HTTP_BAD_REQUEST);
  }

  const ctx = buildContext(shared, resolveTenantId(c));

  try {
    const response = await startDeployment(ctx, { ...parsed.data, problemId });
    return c.json(response, HTTP_ACCEPTED);
  } catch (err) {
    if (err instanceof UnknownProblemError) {
      return c.json({ error: "unknown_problem", problemId }, HTTP_NOT_FOUND);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] startDeployment failed", { problemId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/problems/:problemId/deployments", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid problemId" }, HTTP_BAD_REQUEST);
  }
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid limit" }, HTTP_BAD_REQUEST);
  try {
    const response = await listDeployments(shared, {
      tenantId: resolveTenantId(c),
      problemId,
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] listDeployments failed", { problemId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/deployments", async (c) => {
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid limit" }, HTTP_BAD_REQUEST);
  try {
    const response = await listDeployments(shared, {
      tenantId: resolveTenantId(c),
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] listDeployments(tenant-wide) failed", { message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.get("/deployments/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid jobId" }, HTTP_BAD_REQUEST);
  }
  try {
    const item = await getDeployment(shared, resolveTenantId(c), jobId);
    if (!item) return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    return c.json(item, HTTP_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] getDeployment failed", { jobId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

app.delete("/deployments/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid jobId" }, HTTP_BAD_REQUEST);
  }
  try {
    const outcome = await requestTeardown(shared, resolveTenantId(c), jobId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    if (outcome.kind === "already_deleted") {
      return c.json({ status: "already_deleted" }, HTTP_OK);
    }
    if (outcome.kind === "race") return c.json({ error: "conflict" }, HTTP_CONFLICT);
    if (outcome.kind === "missing_required_fields") {
      return c.json(
        { error: "missing_required_fields", fields: outcome.fields },
        HTTP_INTERNAL_ERROR,
      );
    }
    return c.json({ status: "accepted", previousStatus: outcome.previousStatus }, HTTP_ACCEPTED);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] requestTeardown failed", { jobId, message });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
