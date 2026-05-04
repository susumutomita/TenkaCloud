import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { ZodError } from "zod";
import { createDefaultContext, startDeployment } from "./deploy.js";
import { DeployRequestSchema } from "./types.js";

/**
 * Deploy API Lambda の Hono app。
 *
 * 現状提供する route:
 *   POST /problems/:problemId/deploy
 *
 * 認証: 本 PR では Lambda Function URL の AWS_IAM auth を一次的な gate とする。
 *      将来 Cognito JWT authorizer に差し替える際、`x-tenant-id` を JWT claim から抽出する。
 *      暫定: env var `DEFAULT_TENANT_ID` (deploy 時に install.sh が注入) を使う。
 */

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/problems/:problemId/deploy", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(problemId)) {
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
  const ctx = createDefaultContext(tenantId);

  try {
    const response = await startDeployment(ctx, { ...parsed.data, problemId });
    return c.json(response, 202);
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ error: "validation failed", issues: err.issues }, 400);
    }
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
