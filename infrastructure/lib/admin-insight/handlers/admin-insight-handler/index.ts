import type { Context } from "hono";
import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { isSystemAdmin, resolveCognitoSub } from "./auth.js";
import {
  defaultCfnClient,
  getDeploymentForTenant,
  getStackProgressForTenant,
} from "./deployments.js";
import { getEventDetailForTenant, listEventsForTenant } from "./events.js";
import { defaultPipelineClient, listPipelineExecutions } from "./pipeline-executions.js";
import { buildSharedResources } from "./shared.js";
import { defaultSfnClient, listStateMachineExecutions } from "./state-machine-executions.js";
import { summarizeTenants } from "./summary.js";
import {
  ChangeSystemUserRoleRequestSchema,
  InviteSystemUserRequestSchema,
  routeChangeSystemUserRole,
  routeCreateSystemUser,
  routeDeleteSystemUser,
  routeGetSystemUser,
  routeListSystemUsers,
} from "./system-users-routes.js";

/**
 * Admin Insight API Lambda の Hono app (ADR-011、issue #590 Phase 1.A + #598 Phase 1.B)。
 *
 * routes:
 *   Phase 1.A (issue #590, merged):
 *     GET /admin/insight/tenants/summary?tenantIds=t1,t2,t3
 *
 *   Phase 1.B drill-down (issue #598):
 *     GET /admin/insight/tenants/:tenantId/events
 *     GET /admin/insight/tenants/:tenantId/events/:eventId
 *     GET /admin/insight/tenants/:tenantId/deployments/:jobId
 *     GET /admin/insight/tenants/:tenantId/deployments/:jobId/stack-progress
 *
 * Auth:
 *   - API Gateway HTTP API + JWT Authorizer (ControlPlane UserPool) で 1 段目を通す
 *   - handler 内で `cognito:groups` claim ⊇ {SystemAdmin} を再検査 (2 段目)。Tenant Admin
 *     の token が誤って届いた場合は 403 で弾く (= ADR-011 D2 採用案)
 *
 * Audit:
 *   - 各 read API で `console.log({ event: "admin.insight.read", admin: sub, path })` を出力
 *   - drill-down 詳細では tenantId / eventId / jobId も含めて log (= 誰がどの行を覗いたかが追える)
 *
 * 非機能:
 *   - polling 60s (frontend 側で setInterval) を前提に response は <500ms 目標
 *   - 詳細 endpoint は単 query / Get なので RCU 消費は更に小さい
 */

// SDK clients / env は module scope で 1 度だけ build。warm invoke で connection pool 再利用。
const shared = buildSharedResources();

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TENANT_IDS = 100;
const LIST_LIMIT_MAX = 200;

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

// ====== Phase 1.B drill-down (#598) ======

app.get("/admin/insight/tenants/:tenantId/events", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return c.json({ error: "invalid_tenant_id" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/tenants/:tenantId/events", { tenantId });
  if (forbidden) return forbidden;

  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) {
    return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  }

  try {
    const response = await listEventsForTenant(shared, {
      tenantId,
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] listEventsForTenant failed", { tenantId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/insight/tenants/:tenantId/events/:eventId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const eventId = c.req.param("eventId");
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return c.json({ error: "invalid_tenant_id" }, StatusCodes.BAD_REQUEST);
  }
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return c.json({ error: "invalid_event_id" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/tenants/:tenantId/events/:eventId", {
    tenantId,
    eventId,
  });
  if (forbidden) return forbidden;

  try {
    const detail = await getEventDetailForTenant(shared, tenantId, eventId);
    if (!detail) return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    return c.json(detail, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] getEventDetailForTenant failed", {
      tenantId,
      eventId,
      message,
    });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/insight/tenants/:tenantId/deployments/:jobId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const jobId = c.req.param("jobId");
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return c.json({ error: "invalid_tenant_id" }, StatusCodes.BAD_REQUEST);
  }
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid_job_id" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/tenants/:tenantId/deployments/:jobId", {
    tenantId,
    jobId,
  });
  if (forbidden) return forbidden;

  try {
    const detail = await getDeploymentForTenant(shared, tenantId, jobId);
    if (!detail) return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    return c.json(detail, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] getDeploymentForTenant failed", { tenantId, jobId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/insight/tenants/:tenantId/deployments/:jobId/stack-progress", async (c) => {
  const tenantId = c.req.param("tenantId");
  const jobId = c.req.param("jobId");
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return c.json({ error: "invalid_tenant_id" }, StatusCodes.BAD_REQUEST);
  }
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid_job_id" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(
    c,
    "/admin/insight/tenants/:tenantId/deployments/:jobId/stack-progress",
    { tenantId, jobId },
  );
  if (forbidden) return forbidden;

  try {
    const outcome = await getStackProgressForTenant(
      shared,
      { cfnClient: defaultCfnClient },
      tenantId,
      jobId,
    );
    if (outcome.kind === "not_found") {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    if (outcome.kind === "stack_not_yet_created") {
      // CFn stack 未割当 (= deploy 進行極初期) は 409 で返し、UI 側で「準備中」表示にする。
      return c.json({ error: "stack_not_yet_created" }, StatusCodes.CONFLICT);
    }
    if (outcome.kind === "stack_not_found_in_cfn") {
      return c.json(
        {
          jobId,
          stackName: "",
          region: "",
          consoleUrl: outcome.consoleUrl,
          events: [],
          resources: [],
          stackStatus: undefined,
        },
        StatusCodes.OK,
      );
    }
    return c.json(outcome.progress, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] getStackProgressForTenant failed", {
      tenantId,
      jobId,
      message,
    });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

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

// ====== Issue #814 Phase 2: Deprovisioning Jobs (Step Functions executions) ======

app.get("/admin/insight/state-machine-executions", async (c) => {
  const forbidden = auditAndAuthorize(c, "/admin/insight/state-machine-executions");
  if (forbidden) return forbidden;

  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) {
    return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  }

  try {
    const region = process.env.AWS_REGION ?? "ap-northeast-1";
    const arn = process.env.DEPROVISIONING_STATE_MACHINE_ARN || undefined;
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
    console.error("[admin-insight] listStateMachineExecutions failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

// ====== Issue #949 (ADR-020 Phase C): SystemAdmin user 管理 routes ======
//
// 認可は 2 段: API GW JWT Authorizer + handler 内 `isSystemAdmin` 検査。 mutate (POST / DELETE /
// PATCH) は全部 SystemAdmin only にしている (= 一旦 SystemAdmin と SystemAuditor の中間 role を
// 区別せず、 SystemAuditor は将来 GET だけ pass させる余地として残す)。

const USERNAME_RE = /^[A-Za-z0-9_.@+-]{1,128}$/;

app.get("/admin/insight/system-users", async (c) => {
  const forbidden = auditAndAuthorize(c, "/admin/insight/system-users");
  if (forbidden) return forbidden;
  try {
    const result = await routeListSystemUsers(c);
    return c.json(result.body as never, result.status as 200 | 503);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] list system-users failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.post("/admin/insight/system-users", async (c) => {
  const forbidden = auditAndAuthorize(c, "/admin/insight/system-users[POST]");
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = InviteSystemUserRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  try {
    const result = await routeCreateSystemUser(c, parsed.data);
    return c.json(result.body as never, result.status as 201 | 409 | 503);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] create system-user failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/insight/system-users/:username", async (c) => {
  const username = c.req.param("username");
  if (!username || !USERNAME_RE.test(username)) {
    return c.json({ error: "invalid_username" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/system-users/:username", { username });
  if (forbidden) return forbidden;
  try {
    const result = await routeGetSystemUser(c, username);
    return c.json(result.body as never, result.status as 200 | 404 | 503);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] get system-user failed", { username, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.patch("/admin/insight/system-users/:username", async (c) => {
  const username = c.req.param("username");
  if (!username || !USERNAME_RE.test(username)) {
    return c.json({ error: "invalid_username" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/system-users/:username[PATCH]", {
    username,
  });
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = ChangeSystemUserRoleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  try {
    const result = await routeChangeSystemUserRole(c, username, parsed.data);
    return c.json(result.body as never, result.status as 200 | 404 | 409 | 503);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] change system-user role failed", { username, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.delete("/admin/insight/system-users/:username", async (c) => {
  const username = c.req.param("username");
  if (!username || !USERNAME_RE.test(username)) {
    return c.json({ error: "invalid_username" }, StatusCodes.BAD_REQUEST);
  }
  const forbidden = auditAndAuthorize(c, "/admin/insight/system-users/:username[DELETE]", {
    username,
  });
  if (forbidden) return forbidden;
  try {
    const result = await routeDeleteSystemUser(c, username);
    return c.json(result.body as never, result.status as 200 | 404 | 409 | 503);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[admin-insight] delete system-user failed", { username, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
