import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { resolveCognitoSub, resolveTenantId } from "../deploy-handler/auth.js";
import { buildMicroserviceMigrationRegistrationSharedResources } from "./shared.js";
import { listEndpoints, registerEndpoint } from "./store.js";
import { RegisterEndpointRequestSchema } from "./types.js";

/**
 * Microservice Migration Battle (Phase 2 / Issue #606) の endpoint 登録 API Lambda。
 *
 * routes (tenant API + Cognito JWT authorizer 経由 — `/admin/competitor-accounts` と同 pattern):
 *   POST /problems/microservice-migration-battle/endpoints   — 登録 (slot / url を upsert)
 *   GET  /problems/microservice-migration-battle/endpoints   — 一覧 (tenant 内の現状を返す)
 *
 * 認可: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim から
 * `resolveTenantId(c)` で抽出する (= request body の tenantId は信頼しない / IAM 越境攻撃の防止)。
 */

const shared = buildMicroserviceMigrationRegistrationSharedResources();

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[microservice-migration-registration] uncaught handler error", {
    path: c.req.path,
    message,
  });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

app.get("/problems/microservice-migration-battle/endpoints/healthz", (c) => c.json({ ok: true }));

app.post("/problems/microservice-migration-battle/endpoints", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = RegisterEndpointRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  try {
    const response = await registerEndpoint(
      shared,
      {
        tenantId: resolveTenantId(c),
        nowMs: Date.now(),
        registeredBy: resolveCognitoSub(c),
      },
      parsed.data,
    );
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[microservice-migration-registration] register failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/problems/microservice-migration-battle/endpoints", async (c) => {
  try {
    const response = await listEndpoints(shared, resolveTenantId(c));
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[microservice-migration-registration] list failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
