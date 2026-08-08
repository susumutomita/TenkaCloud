import type { Context } from "hono";
import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../../problem-deploy/control-data/runtime-repositories.js";
import { secureApiHeaders } from "../../../problem-deploy/handlers/shared/secure-headers.js";
import { listUsageFacts } from "../../../problem-deploy/handlers/usage-metering-handler/repository.js";
import { exportAuditEntriesCsv, listAuditEntries } from "./audit.js";
import { isSystemAdmin, resolveCognitoSub } from "./auth.js";
import { defaultBudgetsClient, getCostSummary } from "./cost.js";
import { defaultPipelineClient, listPipelineExecutions } from "./pipeline-executions.js";
import { buildSharedResources, resolveAdminAuditLogRepository } from "./shared.js";
import { defaultSfnClient, listStateMachineExecutions } from "./state-machine-executions.js";
import { summarizeTenants } from "./summary.js";

/**
 * Admin Insight API Lambda の Hono app (Control Plane ops 用)。
 *
 * 残っている routes (= Control Plane の SystemAdmin がオペレーションする上で必要なもの):
 *   GET /admin/insight/healthz
 *   GET /admin/insight/tenants/summary?tenantIds=t1,t2,t3   — tenant 一覧 + tier / status
 *   GET /admin/insight/pipeline-executions                    — tenkacloud-saas-pipeline 実行履歴
 *   GET /admin/insight/state-machine-executions               — SBT deprovisioning SFN 実行履歴
 *   GET /admin/insight/audit                                  — admin 操作 audit log
 *   GET /admin/insight/usage                                  — tenant usage facts (aggregate only)
 *
 * 廃止済 (= 2026-05-18 plane 分離方針、 [[feedback-no-cross-plane-data-leak]]):
 *   - `/admin/insight/tenants/:tenantId/events*`                  — App Plane data 覗き込み
 *   - `/admin/insight/tenants/:tenantId/deployments/:jobId*`      — App Plane data 覗き込み
 *   - `/admin/insight/system-users*`                              — SystemAdmin user CRUD、
 *     UI 経路は token security hole になりやすいため Cognito 直 (admin-create-user / Hosted UI)
 *     に倒した
 *
 * Auth:
 *   - API Gateway HTTP API + JWT Authorizer (ControlPlane UserPool) で 1 段目を通す
 *   - handler 内で `cognito:groups` claim ⊇ {SystemAdmin} を再検査 (2 段目)。Tenant Admin
 *     の token が誤って届いた場合は 403 で弾く (= ADR-011 D2 採用案)
 *
 * Audit:
 *   - 各 read API で `console.log({ event: "admin.insight.read", admin: sub, path })` を出力
 *
 * 非機能:
 *   - polling 60s (frontend 側で setInterval) を前提に response は <500ms 目標
 */

// SDK clients / env は module scope で 1 度だけ build。warm invoke で connection pool 再利用。
// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance.
const shared = buildSharedResources(createDefaultControlDataRuntime());

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TENANT_IDS = 100;
const LIST_LIMIT_MAX = 200;

const app = new Hono();

// #1694: 全レスポンスに API セキュリティヘッダを付与 (nosniff / no-store / X-Frame-Options /
// Referrer-Policy)。 audit CSV export は独自の Content-Disposition を持つため middleware は
// それを尊重 (= 上書きしない)。
app.use("*", secureApiHeaders());

// #1392: CORS は API Gateway HTTP API の corsPreflight (admin-console-insight-stack.ts) が
// localhost dev + admin-console CloudFront origin の allowlist で一元管理する。 ここで Hono の
// `cors({ origin: "*" })` を重ねると、 認証済み SystemAdmin surface に対し任意 origin への
// `Access-Control-Allow-Origin: *` を返してしまうため middleware を置かない。
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[admin-insight] uncaught handler error", { path: c.req.path, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

app.get("/admin/insight/healthz", (c) => c.json({ ok: true }, StatusCodes.OK));

/**
 * `cognito:groups` ⊇ {SystemAdmin} 検査 + audit log を 1 行に集約した route guard。
 * 各 drill-down endpoint で `auditAndAuthorize(c, "/admin/insight/...")` を呼ぶ。
 *
 * 戻り値:
 *   - `null` (= 認可 OK、続行可)
 *   - `Response` (= 403)
 */
function auditAndAuthorize(
  c: Context,
  pathLogLabel: string,
  extra: Record<string, unknown> = {},
): Response | null {
  if (!isSystemAdmin(c)) {
    return c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN);
  }
  const sub = resolveCognitoSub(c);
  console.log({
    event: "admin.insight.read",
    admin: sub,
    path: pathLogLabel,
    ...extra,
  });
  return null;
}

function parseLimit(value: string | undefined): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

function isValidDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseTenantIds(
  raw: string,
):
  | { ok: true; tenantIds: string[] }
  | { ok: false; status: typeof StatusCodes.BAD_REQUEST; body: Record<string, unknown> } {
  if (raw.trim() === "") return { ok: true, tenantIds: [] };
  const tenantIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = tenantIds.find((id) => !TENANT_ID_RE.test(id));
  if (invalid !== undefined) {
    return {
      ok: false,
      status: StatusCodes.BAD_REQUEST,
      body: { error: "invalid_tenant_id", value: invalid },
    };
  }
  if (tenantIds.length > MAX_TENANT_IDS) {
    return {
      ok: false,
      status: StatusCodes.BAD_REQUEST,
      body: { error: "too_many_tenant_ids", max: MAX_TENANT_IDS },
    };
  }
  return { ok: true, tenantIds };
}

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

app.get("/admin/insight/usage", async (c) => {
  const forbidden = auditAndAuthorize(c, "/admin/insight/usage");
  if (forbidden) return forbidden;

  const parsedTenants = parseTenantIds(c.req.query("tenantIds") ?? "");
  if (!parsedTenants.ok) {
    return c.json(parsedTenants.body as never, parsedTenants.status);
  }
  if (parsedTenants.tenantIds.length === 0) {
    return c.json({ items: [] }, StatusCodes.OK);
  }
  if (!shared.usageTableName || shared.usageTableName.length === 0) {
    return c.json(
      {
        error: "usage_facts_unconfigured",
        message: "USAGE_FACTS_TABLE_NAME env が未設定です (= stack 配線漏れ)",
      },
      StatusCodes.SERVICE_UNAVAILABLE,
    );
  }

  const from = c.req.query("from") ?? "1970-01-01";
  const to = c.req.query("to") ?? "9999-12-31";
  if (!isValidDay(from) || !isValidDay(to) || from > to) {
    return c.json({ error: "invalid_day_range" }, StatusCodes.BAD_REQUEST);
  }

  try {
    const response = await listUsageFacts(
      { ddb: shared.ddb, tableName: shared.usageTableName },
      { tenantIds: parsedTenants.tenantIds, from, to },
    );
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] listUsageFacts failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

// Phase 1.B drill-down (旧 #598) は plane 分離方針で廃止
// ([[feedback-no-cross-plane-data-leak]])。 tenant 内の events / deployments は
// application-admin-console (= App Plane UI) で見る。

// ====== Issue #658: Provisioning Jobs (CodePipeline executions) ======

app.get("/admin/insight/pipeline-executions", async (c) => {
  const forbidden = auditAndAuthorize(c, "/admin/insight/pipeline-executions");
  if (forbidden) return forbidden;

  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) {
    return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  }

  try {
    const region = process.env.AWS_REGION ?? "ap-northeast-1";
    const response = await listPipelineExecutions(
      { client: defaultPipelineClient, region },
      { limit: parsedLimit.limit },
    );
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] listPipelineExecutions failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

// ====== Issue #814 Phase 2: Step Functions executions (provisioning / deprovisioning) ======

/**
 * `ListExecutions` を返す 2 route (provisioning / deprovisioning) は、 読む env が違うだけで
 * 認可・limit 検証・not_configured の 503 マップ・例外処理まで同一。 copy-paste すると片方だけ直して
 * もう片方が古いまま残るので 1 か所に集約する。
 *
 * `envVarName` を引数で受けるのは、 module 読み込み時ではなく request 時に `process.env` を読むため
 * (= Lambda の env 差し替えや test の stub が効く)。
 */
function registerStateMachineExecutionsRoute(path: string, envVarName: string): void {
  app.get(path, async (c) => {
    const forbidden = auditAndAuthorize(c, path);
    if (forbidden) return forbidden;

    const parsedLimit = parseLimit(c.req.query("limit"));
    if (!parsedLimit) {
      return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
    }

    try {
      const region = process.env.AWS_REGION ?? "ap-northeast-1";
      const arn = process.env[envVarName] || undefined;
      const response = await listStateMachineExecutions(
        { client: defaultSfnClient, region, stateMachineArn: arn },
        { limit: parsedLimit.limit },
      );
      if (response.kind === "not_configured") {
        // Lambda env が未設定の旧 stack 互換 (= 503 Service Unavailable)。 frontend は legacy
        // placeholder にフォールバックする。
        return c.json({ error: "not_configured" }, StatusCodes.SERVICE_UNAVAILABLE);
      }
      return c.json(response, StatusCodes.OK);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[admin-insight] listStateMachineExecutions failed", { path, message });
      return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
    }
  });
}

/**
 * テナントのプロビジョニングが実際に走るのは SBT ProvisioningScriptJob の state machine で、
 * 「プロビジョニング Jobs」 画面が長らく見ていた CodePipeline とは別経路。 そのため 3 テナントを
 * 同時に provisioning しても画面には 1 件も出ず、 代わりに無関係な pipeline の失敗だけが
 * 「プロビジョニング失敗」として表示されていた (2026-08-08 に運用者が誤認)。
 */
registerStateMachineExecutionsRoute(
  "/admin/insight/provisioning-executions",
  "PROVISIONING_STATE_MACHINE_ARN",
);
registerStateMachineExecutionsRoute(
  "/admin/insight/state-machine-executions",
  "DEPROVISIONING_STATE_MACHINE_ARN",
);

// ====== SystemAdmin user 管理 routes (旧 Issue #949) は廃止 ======
//
// UI 経路で SystemAdmin token を扱うと exfil 経路が増える (= security hole)。 SystemAdmin の
// 招待 / 削除 / role 変更は Cognito 直 (aws cognito-idp admin-create-user / admin-delete-user
// / Hosted UI) に倒す ([[feedback-no-cross-plane-data-leak]] 2026-05-18)。 audit log は
// 引き続き `/admin/insight/audit` で参照可能。

// ====== Issue #950 (ADR-020 Phase D): admin audit log read route ======
// Issue #1292: filter + CSV export 追加 (= date range / principal / action)。

app.get("/admin/insight/audit", handleAuditEntries);
app.get("/admin/insight/audit/export", handleAuditExport);

// ====== Issue #1431: in-console cost / budget visibility (AWS Budgets, 無料) ======
app.get("/admin/insight/cost", handleCostSummary);

async function handleCostSummary(c: Context): Promise<Response> {
  if (!isSystemAdmin(c)) {
    return c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN);
  }
  const accountId = process.env.COST_BUDGET_ACCOUNT_ID ?? "";
  const budgetName = process.env.COST_BUDGET_NAME ?? "";
  // budget / IAM 未配線 (= env 空) は available:false で graceful。 admin-console は
  // この場合 Billing console への外部リンク表示に留め、 画面を壊さない。
  if (!accountId || !budgetName) {
    return c.json({ available: false }, StatusCodes.OK);
  }
  try {
    const summary = await getCostSummary({
      budgets: defaultBudgetsClient(),
      accountId,
      budgetName,
    });
    return c.json({ available: true, ...summary }, StatusCodes.OK);
  } catch {
    // budget 未作成 / 権限不足 (ResourceNotFound / AccessDenied) も available:false に倒す。
    return c.json({ available: false }, StatusCodes.OK);
  }
}

/**
 * [Issue #2442 / Phase C4] `true` for pure-SQL `CONTROL_DATA_BACKEND` values, where the
 * AdminAuditLog table is not synthesized (mirrors `handlers/shared/audit-log.ts`'s
 * `isPureSqlBackend`). An empty `shared.auditTableName` is legitimate there, not a
 * misconfiguration — only the dynamodb backend requires the physical table name.
 */
function isPureSqlBackend(): boolean {
  const backend = process.env.CONTROL_DATA_BACKEND;
  return backend === "turso";
}

async function handleAuditEntries(c: Context): Promise<Response> {
  const forbidden = auditAndAuthorize(c, "/admin/insight/audit");
  if (forbidden) return forbidden;
  if (!isPureSqlBackend() && (!shared.auditTableName || shared.auditTableName.length === 0)) {
    return c.json(
      {
        error: "audit_log_unconfigured",
        message: "ADMIN_AUDIT_LOG_TABLE_NAME env が未設定です (= stack 配線漏れ)",
      },
      StatusCodes.SERVICE_UNAVAILABLE,
    );
  }
  const input = parseAuditListInput(c);
  if ("response" in input) return input.response;
  const { scope, tenantId, limit, cursor, from, to, principal, action } = input;
  try {
    const repository = await resolveAdminAuditLogRepository(shared);
    const result = await listAuditEntries(
      { repository },
      {
        scope,
        ...(tenantId ? { tenantId } : {}),
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(principal ? { principal } : {}),
        ...(action ? { action } : {}),
      },
      shared.environmentName,
    );
    return c.json(result, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] listAuditEntries failed", { scope, tenantId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
}

async function handleAuditExport(c: Context): Promise<Response> {
  const forbidden = auditAndAuthorize(c, "/admin/insight/audit/export");
  if (forbidden) return forbidden;
  if (!isPureSqlBackend() && (!shared.auditTableName || shared.auditTableName.length === 0)) {
    return c.json({ error: "audit_log_unconfigured" }, StatusCodes.SERVICE_UNAVAILABLE);
  }
  const input = parseAuditListInput(c);
  if ("response" in input) return input.response;
  const { scope, tenantId, from, to, principal, action } = input;
  try {
    const repository = await resolveAdminAuditLogRepository(shared);
    const csv = await exportAuditEntriesCsv(
      { repository },
      {
        scope,
        ...(tenantId ? { tenantId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(principal ? { principal } : {}),
        ...(action ? { action } : {}),
      },
      shared.environmentName,
    );
    const filename = buildExportFilename(scope, tenantId);
    return new Response(csv, {
      status: StatusCodes.OK,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] exportAuditEntriesCsv failed", { scope, tenantId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
}

function buildExportFilename(scope: "tenant" | "system", tenantId: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slot = scope === "system" ? "platform" : `tenant-${tenantId ?? "unknown"}`;
  return `audit-${slot}-${stamp}.csv`;
}

function parseAuditListInput(c: Context):
  | {
      readonly scope: "tenant" | "system";
      readonly tenantId: string | undefined;
      readonly limit: number | undefined;
      readonly cursor: string | undefined;
      readonly from: string | undefined;
      readonly to: string | undefined;
      readonly principal: string | undefined;
      readonly action: string | undefined;
    }
  | { readonly response: Response } {
  const rawScope = c.req.query("scope") ?? "tenant";
  if (rawScope !== "tenant" && rawScope !== "system") {
    return { response: c.json({ error: "invalid_scope" }, StatusCodes.BAD_REQUEST) };
  }
  const scope = rawScope as "tenant" | "system";
  const tenantId = c.req.query("tenantId");
  if (scope === "tenant" && (!tenantId || !TENANT_ID_RE.test(tenantId))) {
    return { response: c.json({ error: "invalid_tenant_id" }, StatusCodes.BAD_REQUEST) };
  }
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) {
    return { response: c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST) };
  }
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from && !isIsoTimestamp(from)) {
    return { response: c.json({ error: "invalid_from" }, StatusCodes.BAD_REQUEST) };
  }
  if (to && !isIsoTimestamp(to)) {
    return { response: c.json({ error: "invalid_to" }, StatusCodes.BAD_REQUEST) };
  }
  return {
    scope,
    tenantId,
    limit: parsedLimit.limit,
    cursor: c.req.query("cursor"),
    from,
    to,
    principal: c.req.query("principal"),
    action: c.req.query("action"),
  };
}

function isIsoTimestamp(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
