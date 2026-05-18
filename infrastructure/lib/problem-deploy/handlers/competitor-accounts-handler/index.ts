import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_ROLES,
} from "../deploy-handler/auth.js";
import { extractAuditContext, writeAuditEvent } from "../shared/audit-log.js";
import { routeDelete, routeGet, routePut } from "./saml-routes.js";
import { buildCompetitorAccountsSharedResources } from "./shared.js";
import {
  CompetitorAccountNotFoundError,
  CompetitorAccountNotVerifiedError,
  createCompetitorAccount,
  DuplicateCompetitorAccountError,
  deleteCompetitorAccount,
  ExternalIdMissingForRotationError,
  listCompetitorAccounts,
  rotateExternalIdForAccount,
} from "./store.js";
import { CreateCompetitorAccountRequestSchema } from "./types.js";
import {
  AssumeRoleSanityCheckFailedError,
  ExternalIdMissingError,
  verifyCompetitorAccount,
} from "./verify.js";

/**
 * Competitor Accounts API Lambda の Hono app (Issue #459 / ADR-002 Phase 2.1)。
 *
 * routes (すべて tenant API + Cognito JWT authorizer 経由):
 *   POST   /admin/competitor-accounts                                    — register (= SSM Put + DDB Put)
 *   GET    /admin/competitor-accounts                                    — list (verified / unverified 両方)
 *   POST   /admin/competitor-accounts/{awsAccountId}/verify              — STS AssumeRole sanity check
 *   POST   /admin/competitor-accounts/{awsAccountId}/rotate-external-id  — ExternalId rotation (Phase 3.1)
 *   DELETE /admin/competitor-accounts/{awsAccountId}                     — remove (last row なら SSM 鍵も削除)
 *
 * Auth: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim
 * から `resolveTenantId(c)` で抽出する。**request body の tenantId は信頼しない** (= IAM 越境攻撃の防止)。
 */

const AWS_ACCOUNT_ID_RE = /^\d{12}$/;

const shared = buildCompetitorAccountsSharedResources();

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

// 想定外 throw を 500 JSON で返す (= CORS headers 付きで browser が body を読める、PR-559 同様)。
app.onError((err, c) => {
  if (err instanceof MissingTenantClaimError) {
    console.warn("[competitor-accounts] missing tenantId claim", { path: c.req.path });
    return c.json(
      { error: "missing_tenant_claim", message: err.message },
      StatusCodes.UNAUTHORIZED,
    );
  }
  // Issue #854 / ADR-020 Phase B.1 (#948): role 不一致は 403、 actualRole / requiredRoles は
  // body に出さず log にだけ残す (= attacker に attack surface を教えない)。
  if (err instanceof ForbiddenRoleError) {
    console.warn("[competitor-accounts] forbidden role", {
      path: c.req.path,
      method: c.req.method,
      actualRole: err.actualRole,
      requiredRoles: err.requiredRoles,
    });
    // Issue #950 (ADR-020 Phase D): forbidden_role を audit に残す (= 「誰が何を試みたか」 が
    // 1 query で引ける)。 tenantId 不明 (= claim 不在 / 越境) の場合は "unknown" を入れる。
    const auditCtx = extractAuditContext(c);
    let tenantId = "unknown";
    try {
      tenantId = resolveTenantId(c);
    } catch {
      // tenantId 不明でも audit は試みる
    }
    void writeAuditEvent({
      tenantId,
      actor: auditCtx.actor,
      actorUsername: auditCtx.actorUsername,
      action: `${c.req.method} ${c.req.path}`,
      outcome: "forbidden",
      ipAddress: auditCtx.ipAddress,
      userAgent: auditCtx.userAgent,
      occurredAtMs: Date.now(),
      extra: {
        actualRole: err.actualRole ?? "(none)",
        requiredRoles: err.requiredRoles.join(","),
      },
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
  console.error("[competitor-accounts] uncaught handler error", {
    path: c.req.path,
    message,
  });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

// ADR-020 Phase B.1 (#948): /admin/* は 「tenant 内の認証済 user」 (= Admin / Operator / Viewer
// のいずれか) を要求する。 destructive 操作 (= POST / DELETE / PATCH) は各 route の 1 行目で
// `requireRole(c, [TENANT_ADMIN_ROLE])` を呼んで Admin 限定にする。 GET 系のうち
// `/admin/competitor-accounts` は 3 role 全部 pass (= EventCreate 画面 dropdown populate に
// 必要、 Viewer も verified accounts を見る)。 SAML 設定 / user 管理 は GET も含めて Admin only
// (= sensitive config / user 一覧)。
// healthz は role check 自体を skip。
app.use("/admin/*", async (c, next) => {
  if (c.req.path.endsWith("/healthz")) {
    return next();
  }
  requireRole(c, TENANT_ROLES);
  return next();
});

app.get("/admin/competitor-accounts/healthz", (c) => c.json({ ok: true }));

// Issue #839 follow-up Phase B: Tenant 管理者が画面 / API から SAML IdP を CRUD する経路。
// 同 Lambda に同居させる (= 同 IAM / auth、 別 handler 化は Phase 3 で再評価)。
// ADR-020 Phase B.1 (#948): SAML 設定は sensitive config なので GET も含めて Admin only。
app.get("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeGet({ shared }, c);
  return c.json(result.body as never, result.status as 200);
});
// 互換のため PATCH + PUT 両方受ける (= frontend は PATCH、 curl 直叩き / OpenAPI は PUT で書く)。
app.patch("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routePut({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 400 | 422);
});
app.put("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routePut({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 400 | 422);
});
app.delete("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeDelete({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 422);
});

app.post("/admin/competitor-accounts", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = CreateCompetitorAccountRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  const tenantIdForCreate = resolveTenantId(c);
  const auditCreate = extractAuditContext(c);
  try {
    const response = await createCompetitorAccount(
      shared,
      {
        tenantId: tenantIdForCreate,
        nowMs: Date.now(),
        createdBy: resolveCognitoSub(c),
      },
      parsed.data,
    );
    // Issue #950: success audit (= 「誰が tenant にどの competitor account を追加したか」)
    void writeAuditEvent({
      tenantId: tenantIdForCreate,
      actor: auditCreate.actor,
      actorUsername: auditCreate.actorUsername,
      action: "create_competitor_account",
      outcome: "success",
      target: parsed.data.awsAccountId,
      ipAddress: auditCreate.ipAddress,
      userAgent: auditCreate.userAgent,
      occurredAtMs: Date.now(),
    });
    return c.json(response, StatusCodes.CREATED);
  } catch (err) {
    if (err instanceof DuplicateCompetitorAccountError) {
      void writeAuditEvent({
        tenantId: tenantIdForCreate,
        actor: auditCreate.actor,
        actorUsername: auditCreate.actorUsername,
        action: "create_competitor_account",
        outcome: "conflict",
        target: err.awsAccountId,
        ipAddress: auditCreate.ipAddress,
        userAgent: auditCreate.userAgent,
        occurredAtMs: Date.now(),
      });
      return c.json(
        { error: "duplicate_account", awsAccountId: err.awsAccountId },
        StatusCodes.CONFLICT,
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] create failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/competitor-accounts", async (c) => {
  try {
    const items = await listCompetitorAccounts(shared, resolveTenantId(c));
    return c.json({ items }, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] list failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.post("/admin/competitor-accounts/:awsAccountId/verify", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const awsAccountId = c.req.param("awsAccountId");
  if (!awsAccountId || !AWS_ACCOUNT_ID_RE.test(awsAccountId)) {
    return c.json({ error: "invalid_account_id" }, StatusCodes.BAD_REQUEST);
  }
  try {
    const account = await verifyCompetitorAccount(shared, {
      tenantId: resolveTenantId(c),
      awsAccountId,
      nowMs: Date.now(),
    });
    return c.json(account, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CompetitorAccountNotFoundError) {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    if (err instanceof ExternalIdMissingError) {
      return c.json({ error: "external_id_missing" }, StatusCodes.CONFLICT);
    }
    if (err instanceof AssumeRoleSanityCheckFailedError) {
      // STS の Error name を operator に渡す (= AccessDenied / ExternalIdMismatch を判別できる)。
      return c.json(
        {
          error: "assume_role_failed",
          underlyingErrorName: err.underlyingErrorName,
        },
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] verify failed", { awsAccountId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.post("/admin/competitor-accounts/:awsAccountId/rotate-external-id", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const awsAccountId = c.req.param("awsAccountId");
  if (!awsAccountId || !AWS_ACCOUNT_ID_RE.test(awsAccountId)) {
    return c.json({ error: "invalid_account_id" }, StatusCodes.BAD_REQUEST);
  }
  const tenantId = resolveTenantId(c);
  const rotatedBy = resolveCognitoSub(c);
  try {
    const response = await rotateExternalIdForAccount(shared, {
      tenantId,
      awsAccountId,
      nowMs: Date.now(),
    });
    // Phase 3.2 / Issue #603: rotation 監査ログ (structured 1-line)。
    //
    // CloudWatch Logs Insights で `event = "competitor-accounts.rotate"` を grep し、
    // 「いつ・どの operator (Cognito sub) が・どの (tenant, account) を rotate したか」を
    // 後追いできる。DDB の専用 audit table を作らない代わりに log を正本にする
    // (= ZERO 新 infra、operator 監査は infrequent なので Logs Insights で十分)。
    //
    // Issue #864: timing 分析で attack window を絞られないように `rotatedAt` を分単位に
    // 粗化する (= ISO8601 の秒以下を 00 に切り詰め)。 audit 用途では分単位で十分。
    const rotatedAtCoarse = response.rotatedAt.replace(/:\d{2}\.\d+Z$/, ":00.000Z");
    console.log(
      JSON.stringify({
        event: "competitor-accounts.rotate",
        tenantId,
        awsAccountId,
        rotatedBy,
        rotatedAt: rotatedAtCoarse,
      }),
    );
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CompetitorAccountNotFoundError) {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    // Issue #868: verified=false な row への rotate は 409 + 明示メッセージで operator に
    // 「先に verify を成功させて」 と返す。 attacker spoof 経路に鍵を回さない。
    if (err instanceof CompetitorAccountNotVerifiedError) {
      return c.json({ error: "not_verified" }, StatusCodes.CONFLICT);
    }
    if (err instanceof ExternalIdMissingForRotationError) {
      return c.json({ error: "external_id_missing" }, StatusCodes.CONFLICT);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] rotate failed", { awsAccountId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.delete("/admin/competitor-accounts/:awsAccountId", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const awsAccountId = c.req.param("awsAccountId");
  if (!awsAccountId || !AWS_ACCOUNT_ID_RE.test(awsAccountId)) {
    return c.json({ error: "invalid_account_id" }, StatusCodes.BAD_REQUEST);
  }
  const tenantIdForDelete = resolveTenantId(c);
  const auditDelete = extractAuditContext(c);
  try {
    await deleteCompetitorAccount(shared, tenantIdForDelete, awsAccountId);
    // Issue #950: success audit (= competitor account 削除は IAM 越境表面に影響)
    void writeAuditEvent({
      tenantId: tenantIdForDelete,
      actor: auditDelete.actor,
      actorUsername: auditDelete.actorUsername,
      action: "delete_competitor_account",
      outcome: "success",
      target: awsAccountId,
      ipAddress: auditDelete.ipAddress,
      userAgent: auditDelete.userAgent,
      occurredAtMs: Date.now(),
    });
    return c.json({ deleted: true }, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CompetitorAccountNotFoundError) {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] delete failed", { awsAccountId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
