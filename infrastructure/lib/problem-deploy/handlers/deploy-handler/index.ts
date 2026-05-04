import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { buildContext, buildSharedResources, startDeployment } from "./deploy.js";
import { DeployRequestSchema } from "./types.js";

/**
 * Deploy API Lambda の Hono app。route:
 *   POST /problems/:problemId/deploy
 *
 * Auth: Lambda Function URL AWS_IAM が一次 gate。tenantId は `DEFAULT_TENANT_ID`
 * env から取り出す (Cognito JWT authorizer 結線時に JWT claim から差し替え予定)。
 */

// problemId は metadata.json と整合する RFC 1035-ish の slug。両端は英数字、内側のみハイフン許容。
const PROBLEM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

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

  const tenantId = process.env.DEFAULT_TENANT_ID ?? "unknown-tenant";
  const ctx = buildContext(shared, tenantId);

  try {
    const response = await startDeployment(ctx, { ...parsed.data, problemId });
    return c.json(response, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] startDeployment failed", { problemId, message });
    return c.json({ error: "internal_error" }, 500);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
