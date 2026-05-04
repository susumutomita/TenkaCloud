import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { resolveTenantId } from "./auth.js";
import { requestTeardown } from "./delete.js";
import { buildContext, buildSharedResources, startDeployment } from "./deploy.js";
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

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/problems/:problemId/deploy", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid problemId" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = DeployRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
  }

  const ctx = buildContext(shared, resolveTenantId(c));

  try {
    const response = await startDeployment(ctx, { ...parsed.data, problemId });
    return c.json(response, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] startDeployment failed", { problemId, message });
    return c.json({ error: "internal_error" }, 500);
  }
});

app.get("/problems/:problemId/deployments", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid problemId" }, 400);
  }
  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX)) {
    return c.json({ error: "invalid limit" }, 400);
  }
  try {
    const response = await listDeployments(shared, {
      tenantId: resolveTenantId(c),
      problemId,
      limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] listDeployments failed", { problemId, message });
    return c.json({ error: "internal_error" }, 500);
  }
});

app.get("/deployments/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid jobId" }, 400);
  }
  try {
    const item = await getDeployment(shared, resolveTenantId(c), jobId);
    if (!item) return c.json({ error: "not_found" }, 404);
    return c.json(item, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] getDeployment failed", { jobId, message });
    return c.json({ error: "internal_error" }, 500);
  }
});

app.delete("/deployments/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid jobId" }, 400);
  }
  try {
    const outcome = await requestTeardown(shared, resolveTenantId(c), jobId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (outcome.kind === "already_deleted") return c.json({ status: "already_deleted" }, 200);
    if (outcome.kind === "race") return c.json({ error: "conflict" }, 409);
    return c.json({ status: "accepted", previousStatus: outcome.previousStatus }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] requestTeardown failed", { jobId, message });
    return c.json({ error: "internal_error" }, 500);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
