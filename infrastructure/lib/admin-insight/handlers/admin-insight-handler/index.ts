import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { isSystemAdmin, resolveCognitoSub } from "./auth.js";
import { buildSharedResources } from "./shared.js";
import { summarizeTenants } from "./summary.js";

/**
 * Admin Insight API Lambda の Hono app (ADR-011 Phase 1.A、issue #590)。
 *
 * routes (Phase 1.A):
 *   GET /admin/insight/tenants/summary?tenantIds=t1,t2,t3
 *     → { items: [{ tenantId, activeDeploys, failedDeploys, totalEvents }] }
 *
 * Auth:
 *   - API Gateway HTTP API + JWT Authorizer (ControlPlane UserPool) で 1 段目を通す
 *   - handler 内で `cognito:groups` claim ⊇ {SystemAdmin} を再検査 (2 段目)。Tenant Admin
 *     の token が誤って届いた場合は 403 で弾く (= ADR-011 D2 採用案)
 *
 * Audit:
 *   - 各 read API で `console.log({ event: "admin.insight.read", admin: sub, path })` を出力
 *   - operator は CloudWatch Logs Insights で `admin.insight.read` を query して誰がいつ
 *     何を見たか追える (= ADR-011 D5 採用案)
 *
 * 非機能:
 *   - polling 60s (frontend 側で setInterval) を前提に response は <500ms 目標
 *   - tenant 数 ~5 × deployments/tenant ~50 ≒ 250 行 query で Free Tier RCU 内に収まる
 *   - Phase 3 (dashboard) で tenant 数が伸びるなら summary.ts の query 戦略を pre-aggregation に置換
 */

// SDK clients / env は module scope で 1 度だけ build。warm invoke で connection pool 再利用。
const shared = buildSharedResources();

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TENANT_IDS = 100;

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
    maxAge: 600,
  }),
);

// 既存 handler (deploy / event) と同じ defensive layer。handler 内 try/catch を漏れた
// throw (= middleware や module init で発生) を 500 + CORS headers で返し、browser が
// "Failed to fetch" で詰まないようにする。response body には message を含めない (= 内部
// IAM ARN / table 名 / stack trace の漏洩を防ぐ)。
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[admin-insight] uncaught handler error", { path: c.req.path, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

app.get("/admin/insight/healthz", (c) => c.json({ ok: true }, StatusCodes.OK));

app.get("/admin/insight/tenants/summary", async (c) => {
  // ADR-011 D2: 2 段目の SystemAdmin claim check。1 段目は API GW JWT Authorizer。
  if (!isSystemAdmin(c)) {
    return c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN);
  }

  // ADR-011 D5: structured audit log。tenant 一覧の中身を log には残さず、admin sub と
  // path だけを残す (= 監査要件は「誰がいつ覗いたか」が分かれば十分、内容は別 storage)。
  const sub = resolveCognitoSub(c);
  console.log({
    event: "admin.insight.read",
    admin: sub,
    path: "/admin/insight/tenants/summary",
  });

  const raw = c.req.query("tenantIds") ?? "";
  // 空 query なら 200 + 空配列を返す (= frontend の初期状態 / tenant 0 件で副作用無し)。
  if (raw.trim() === "") {
    return c.json({ items: [] }, StatusCodes.OK);
  }

  const tenantIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // ID 形式 validation。tenant ID は SBT の UUID 形式 (or 自前識別子) を想定。
  // DDB query の partition key に直接埋めるので、安全側で文字種を絞る。
  const invalid = tenantIds.find((id) => !TENANT_ID_RE.test(id));
  if (invalid !== undefined) {
    return c.json({ error: "invalid_tenant_id", value: invalid }, StatusCodes.BAD_REQUEST);
  }
  // Free Tier 圧迫防止 + 単一 invoke の timeout 防止のため上限 100 件 (= MVP-1 想定の 5 倍)。
  if (tenantIds.length > MAX_TENANT_IDS) {
    return c.json({ error: "too_many_tenant_ids", max: MAX_TENANT_IDS }, StatusCodes.BAD_REQUEST);
  }

  try {
    const response = await summarizeTenants(shared, tenantIds);
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] summarizeTenants failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
