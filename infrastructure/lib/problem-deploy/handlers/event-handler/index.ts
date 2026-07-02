import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { TENANT_ADMIN_ROLE, TENANT_ROLES } from "../deploy-handler/auth.js";
import { buildAuthErrorHandler, createRoleCheckMiddleware } from "../shared/auth-wiring.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import { registerAuditLogRoutes } from "./routes/audit-log.js";
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

// #1694: API セキュリティヘッダを CORS より前 (outermost) に適用 (= onError 経路にも付与)。
app.use("*", secureApiHeaders());

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

// #559 defensive layer (詳細は shared/auth-wiring.ts の JSDoc を参照): handler 内 try/catch を
// 漏れた exception を onError で Hono response として返し、CORS middleware を通して
// Access-Control-* headers を付ける (= browser が「Failed to fetch」ではなく body の `error`
// を読める)。`message` は logs だけに残し response body には含めない (PR-570 review)。operator
// は CloudWatch Logs の `[events] uncaught handler error` 行で詳細を引く。
app.onError(buildAuthErrorHandler({ logPrefix: "[events]" }));

// ADR-020 Phase B.1 (#948): /events/* は 「tenant 内の認証済 user」 (= Admin / Operator /
// Viewer のいずれか) を要求し、 destructive / mutate 操作は各 route の 1 行目で `requireRole(c,
// [...])` を呼んで absolute に絞る。 GET 系 (= list / detail / disruption catalog / audit) は
// 3 role 全部 OK (= Viewer も event 観覧可)。
// healthz は skip。
app.use("/events/*", createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_ROLES }));

// Issue #2200: 本 Lambda は /events/* に加えて /admin/* (= audit-log read) も配信する。
// 各 handler 1 行目の `requireRole` (defense in depth として残す) に加えて blanket でも
// TenantAdmin を要求し、 将来 /admin/* に route を足して requireRole を書き忘れても
// fail-closed になるよう deploy-handler ("*") / competitor-accounts-handler ("/admin/*")
// と構造を揃える。
app.use(
  "/admin/*",
  createRoleCheckMiddleware({ healthzPath: "/healthz", roles: [TENANT_ADMIN_ROLE] }),
);

app.get("/events/healthz", (c) => c.json({ ok: true }));

registerEventRoutes(app, shared);
registerLifecycleRoutes(app, shared);
registerScoringRoutes(app, shared);
registerNotificationRoutes(app, shared);
registerBulkDeployRoutes(app, shared);
registerDisruptionRoutes(app, shared);
// Issue #1292: Tenant Admin 向け audit log read routes (= /admin/audit-log + /export)。
registerAuditLogRoutes(app, shared);

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
