import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { TENANT_ADMIN_ROLE, TENANT_BLANKET_ROLES, TENANT_ROLES } from "../deploy-handler/auth.js";
import { buildAuthErrorHandler, createRoleCheckMiddleware } from "../shared/auth-wiring.js";
import { createMachineGuardMiddleware } from "../shared/machine-principal.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import { registerAuditLogRoutes } from "./routes/audit-log.js";
import { registerBulkDeployRoutes } from "./routes/bulk-deploy.js";
import { registerCapacityRoutes } from "./routes/capacity.js";
import { registerCoordinationRoutes } from "./routes/coordination.js";
import { registerDisruptionRoutes } from "./routes/disruptions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerFeatureFlagsRoutes } from "./routes/feature-flags.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerProgressionGateRoutes } from "./routes/progression-gate.js";
import { registerScoringRoutes } from "./routes/scoring.js";
import { buildEventSharedResources } from "./shared.js";

/**
 * Event API Lambda の Hono app (2a, Notifications)。routes:
 *   POST   /events
 *   GET    /events
 *   GET    /events/:eventId
 *   PATCH  /events/:eventId/schedule
 *   POST   /events/:eventId/end
 *   POST   /events/:eventId/lock-scoring
 *   DELETE /events/:eventId/lock-scoring
 *   PUT    /events/:eventId/progression-gate — Progression Gate 設定 (#2283, flag ON のみ)
 *   DELETE /events/:eventId/progression-gate — Gate 設定除去 (idempotent)
 *   POST   /events/:eventId/notifications — 運営 → 競技者 通知 1 件作成
 *   POST   /events/:eventId/archive
 *   POST   /events/:eventId/deploy         — Bulk deploy (teams × problems を fan-out)
 *   GET    /events/:eventId/disruptions          — Red Team disruption catalog (#888 Phase A)
 *   GET    /events/:eventId/disruptions/audit    — Disruption 発火履歴
 *   POST   /events/:eventId/disruptions/fire     — Disruption を fire
 *   DELETE /events/:eventId                — Bulk teardown
 *   GET    /feature-flags                  — per-tenant runtime feature-flag overrides (#2231, any tenant role)
 *   PUT    /admin/feature-flags            — full-replace the override set (TenantAdmin only)
 *   GET    /admin/capacity                 — event-hot DynamoDB キャパ監視 (#2410, TenantAdmin only)
 *
 * Auth: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim
 * から `resolveTenantId` で抽出する (DeployApi Lambda と同じ shape)。
 *
 * 各 route group の実装は `./routes/<group>.ts` に分割。 本 index は
 * middleware / onError handler / route group の wiring のみを担当する (Issue #1250)。
 */

// [#2527 Slice 4] Composition root: the entrypoint creates the real control-data
// runtime once per Lambda instance (cold-start cache preserved) and injects it.
const shared = buildEventSharedResources(createDefaultControlDataRuntime());

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

// Issue #2948: machine guard は全 route の先頭で発火させる (blanket が /events/*/
// /feature-flags / /admin/* に分かれているため、"*" に 1 本置くのが唯一の網羅的な位置)。
app.use("*", createMachineGuardMiddleware());

// Issue #948: /events/* は 「tenant 内の認証済 user」 (Admin / Operator /
// Viewer のいずれか) を要求し、 destructive / mutate 操作は各 route の 1 行目で `requireRole(c,
// [...])` を呼んで absolute に絞る。 GET 系 (= list / detail / disruption catalog / audit) は
// 3 role 全部 OK (= Viewer も event 観覧可)。
// healthz は skip。
// #2948: **`/events/*` blanket だけ** `TENANT_BLANKET_ROLES` にする。Phase 1 allowlist の
// `GET /events` / `GET /events/{eventId}` を通すためで、他の /events/* route は per-route の
// `requireRole` (human 3 値) で落ちる。`/feature-flags` と `/admin/*` は下で変更しない。
app.use(
  "/events/*",
  createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_BLANKET_ROLES }),
);

// Issue #2231: /feature-flags (GET) is readable by any authenticated tenant role, same
// gate as /events/* — `config.features` must resolve for TenantOperator / TenantViewer too
// (e.g. the redTeam flag gates a tab all three roles can view). Only the PUT (below, under
// /admin/*) is TenantAdmin-only.
app.use(
  "/feature-flags",
  createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_ROLES }),
);

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
// Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) 設定 routes。
registerProgressionGateRoutes(app, shared);
registerNotificationRoutes(app, shared);
registerBulkDeployRoutes(app, shared);
// [Issue #3126] Explicit coordination run reset — deliberately NOT folded into
// the deploy route, which runs against live events.
registerCoordinationRoutes(app, shared);
registerDisruptionRoutes(app, shared);
// Issue #1292: Tenant Admin 向け audit log read routes (= /admin/audit-log + /export)。
registerAuditLogRoutes(app, shared);
// Issue #2231: per-tenant runtime feature-flag toggle (/admin/feature-flags)。
registerFeatureFlagsRoutes(app, shared);
// Issue #2410 Slice 2: event-hot DynamoDB キャパ監視 (= /admin/capacity、read-only)。
registerCapacityRoutes(app, shared);

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
