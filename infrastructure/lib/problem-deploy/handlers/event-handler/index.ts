import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  TENANT_ROLES,
} from "../deploy-handler/auth.js";
import { registerBulkDeployRoutes } from "./routes/bulk-deploy.js";
import { registerDisruptionRoutes } from "./routes/disruptions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerScoringRoutes } from "./routes/scoring.js";
import { buildEventSharedResources } from "./shared.js";

/**
 * Event API Lambda の Hono app (ADR-004 Phase 1+2a, ADR-006 Notifications)。routes:
 *   POST   /events
 *   GET    /events
 *   GET    /events/:eventId
 *   PATCH  /events/:eventId/schedule
 *   POST   /events/:eventId/end
 *   POST   /events/:eventId/lock-scoring
 *   DELETE /events/:eventId/lock-scoring
 *   POST   /events/:eventId/notifications  — 運営 → 競技者 通知 1 件作成 (ADR-006)
 *   POST   /events/:eventId/archive
 *   POST   /events/:eventId/deploy         — Bulk deploy (teams × problems を fan-out)
 *   GET    /events/:eventId/disruptions          — Red Team disruption catalog (#888 Phase A)
 *   GET    /events/:eventId/disruptions/audit    — Disruption 発火履歴
 *   POST   /events/:eventId/disruptions/fire     — Disruption を fire
 *   DELETE /events/:eventId                — Bulk teardown
 *
 * Auth: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim
 * から `resolveTenantId` で抽出する (DeployApi Lambda と同じ shape)。
 *
 * 各 route group の実装は `./routes/<group>.ts` に分割。 本 index は
 * middleware / onError handler / route group の wiring のみを担当する (Issue #1250)。
 */

const shared = buildEventSharedResources();

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

// #559 defensive layer: handler 内 try/catch を漏れた exception (= 例えば
// `resolveTenantId(c)` の throw、middleware の throw、type 違い等) が API Gateway 層に
// 抜けると 500 + no CORS headers で返ってしまい、browser は「Failed to fetch」とだけ
// 表示して response body を読めない。onError で 500 を Hono response として返せば
// CORS middleware を通って Access-Control-* headers が付き、browser は body の
// `error` field を読めるようになる (= CloudWatch Logs に到達する前に UI で原因が見える)。
//
// `message` は **logs だけ** に残し response body には含めない (= 内部 IAM ARN / table 名 /
// stack trace 等が browser に漏れない、PR-570 review 指摘)。operator は CloudWatch Logs
// の `[events] uncaught handler error` 行で詳細を引く。
app.onError((err, c) => {
  if (err instanceof MissingTenantClaimError) {
    console.warn("[events] missing tenantId claim", { path: c.req.path });
    return c.json(
      { error: "missing_tenant_claim", message: err.message },
      StatusCodes.UNAUTHORIZED,
    );
  }
  // Issue #854 / ADR-020 Phase B.1 (#948): role 不一致は 403、 detail は body に出さず log のみ。
  if (err instanceof ForbiddenRoleError) {
    console.warn("[events] forbidden role", {
      path: c.req.path,
      method: c.req.method,
      actualRole: err.actualRole,
      requiredRoles: err.requiredRoles,
    });
    return c.json(
      {
        error: "forbidden_role",
        message: "あなたの tenant role ではこの操作を実行できません",
      },
      StatusCodes.FORBIDDEN,
    );
  }
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[events] uncaught handler error", { path: c.req.path, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

// ADR-020 Phase B.1 (#948): /events/* は 「tenant 内の認証済 user」 (= Admin / Operator /
// Viewer のいずれか) を要求し、 destructive / mutate 操作は各 route の 1 行目で `requireRole(c,
// [...])` を呼んで absolute に絞る。 GET 系 (= list / detail / disruption catalog / audit) は
// 3 role 全部 OK (= Viewer も event 観覧可)。
// healthz は skip。
app.use("/events/*", async (c, next) => {
  if (c.req.path.endsWith("/healthz")) {
    return next();
  }
  requireRole(c, TENANT_ROLES);
  return next();
});

app.get("/events/healthz", (c) => c.json({ ok: true }));

registerEventRoutes(app, shared);
registerLifecycleRoutes(app, shared);
registerScoringRoutes(app, shared);
registerNotificationRoutes(app, shared);
registerBulkDeployRoutes(app, shared);
registerDisruptionRoutes(app, shared);

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
