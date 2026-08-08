import { type Context, Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";
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
import { respondMachineRouteDenied } from "../shared/auth-wiring.js";
import { parseJsonBody } from "../shared/http-parse.js";
import {
  createMachineGuardMiddleware,
  MachineRouteDeniedError,
} from "../shared/machine-principal.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import { routeDelete, routeGet, routePut } from "./saml-routes.js";
import { buildCompetitorAccountsSharedResources } from "./shared.js";
import {
  CompetitorAccountNotFoundError,
  createCompetitorAccount,
  DuplicateCompetitorAccountError,
  deleteCompetitorAccount,
  listCompetitorAccounts,
} from "./store.js";
import {
  handleDeleteTeamCredential,
  handleGetTeamCredentialStatus,
  handleRegisterTeamCredential,
  isTeamCredentialProvider,
} from "./team-credentials-routes.js";
import { CreateCompetitorAccountRequestSchema } from "./types.js";
import {
  routeChangeUserRole,
  routeCreateUser,
  routeDeleteUser,
  routeListUsers,
} from "./users-routes.js";
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
 *   DELETE /admin/competitor-accounts/{awsAccountId}                     — remove (last row なら SSM 鍵も削除)
 *
 * Issue #1089: 旧 \`POST .../rotate-external-id\` は廃止。 ExternalId を更新したい
 * 場合は account を DELETE → POST (create) で新規払い出す経路に統一する。
 *
 * Auth: tenant API GW + Cognito JWT authorizer。tenantId は JWT `custom:tenantId` claim
 * から `resolveTenantId(c)` で抽出する。**request body の tenantId は信頼しない** (= IAM 越境攻撃の防止)。
 */

const AWS_ACCOUNT_ID_RE = /^\d{12}$/;

// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance.
const shared = buildCompetitorAccountsSharedResources(createDefaultControlDataRuntime());

const app = new Hono();

// #1694: API セキュリティヘッダを CORS より前 (outermost) に適用 (= onError 経路にも付与)。
app.use("*", secureApiHeaders());

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
    maxAge: 600,
  }),
);

// 想定外 throw を 500 JSON で返す (= CORS headers 付きで browser が body を読める、PR-559 同様)。
app.onError(async (err, c) => {
  // #2948: machine guard の拒否。この Lambda で guard は **load-bearing ではない** —
  // `/admin/*` blanket は `TENANT_ROLES` のままなので、machine principal は guard が無くても
  // `ForbiddenRoleError` で fail-closed になる。guard を mount する目的は「より早く落とし、
  // 拒否理由を audit に残す」ことだけである。
  if (err instanceof MachineRouteDeniedError) {
    return respondMachineRouteDenied(err, c, "[competitor-accounts]");
  }
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
// #2948: machine guard を blanket より前に mount する (= 拒否理由を audit に残す)。
// blanket は `TENANT_ROLES` のまま **widen しない**。
app.use("*", createMachineGuardMiddleware());

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
  return c.json(result.body, result.status);
});
// 互換のため PATCH + PUT 両方受ける (= frontend は PATCH、 curl 直叩き / OpenAPI は PUT で書く)。
app.patch("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routePut({ shared }, c);
  return c.json(result.body, result.status);
});
app.put("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routePut({ shared }, c);
  return c.json(result.body, result.status);
});
app.delete("/admin/tenant-saml-config", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeDelete({ shared }, c);
  return c.json(result.body, result.status);
});

app.get("/admin/users", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeListUsers({ shared }, c);
  return c.json(result.body, result.status);
});

app.post("/admin/users", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeCreateUser({ shared }, c);
  return c.json(result.body, result.status);
});

app.delete("/admin/users/:username", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeDeleteUser({ shared }, c);
  return c.json(result.body, result.status);
});

app.patch("/admin/users/:username", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const result = await routeChangeUserRole({ shared }, c);
  return c.json(result.body, result.status);
});

app.post("/admin/competitor-accounts", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const parsed = await parseJsonBody(c, CreateCompetitorAccountRequestSchema);
  if (!parsed.ok) return parsed.response;
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

// #1089: Rotate ExternalId endpoint は廃止 (= 仕様簡素化)。 ExternalId を更新したい
// 場合は account を delete → create の 2 step で新規 ExternalId を払い出す。

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

// [ADR-026/027/032 / Issue #1413] per-team cloud credential onboarding (sakura/azure/gcp)。
// TenantAdmin が非 AWS 問題の deploy 前に per-team 認証情報を SSM SecureString store に登録 / 失効する。
// path: /admin/team-cloud-credentials/{provider}/{teamSlug}。 tenantId は JWT claim (body 非信頼)。
const TEAM_SLUG_RE = /^[a-z0-9-]+$/;

function resolveTeamCredentialParams(
  c: Context,
): { provider: "sakura" | "azure" | "gcp"; teamSlug: string } | { error: string } {
  const provider = c.req.param("provider");
  const teamSlug = c.req.param("teamSlug");
  if (!provider || !isTeamCredentialProvider(provider)) return { error: "unknown_provider" };
  if (!teamSlug || !TEAM_SLUG_RE.test(teamSlug)) return { error: "invalid_team_slug" };
  return { provider, teamSlug };
}

app.put("/admin/team-cloud-credentials/:provider/:teamSlug", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const params = resolveTeamCredentialParams(c);
  if ("error" in params) return c.json({ error: params.error }, StatusCodes.BAD_REQUEST);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  const tenantId = resolveTenantId(c);
  const audit = extractAuditContext(c);
  try {
    const result = await handleRegisterTeamCredential(
      { shared },
      params.provider,
      tenantId,
      params.teamSlug,
      body,
    );
    void writeAuditEvent({
      tenantId,
      actor: audit.actor,
      actorUsername: audit.actorUsername,
      action: "register_team_cloud_credential",
      outcome: result.status === StatusCodes.CREATED ? "success" : "error",
      target: `${params.provider}:${params.teamSlug}`,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
      occurredAtMs: Date.now(),
    });
    return c.json(result.body, result.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[team-credentials] register failed", {
      provider: params.provider,
      message,
    });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.delete("/admin/team-cloud-credentials/:provider/:teamSlug", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const params = resolveTeamCredentialParams(c);
  if ("error" in params) return c.json({ error: params.error }, StatusCodes.BAD_REQUEST);
  const tenantId = resolveTenantId(c);
  const audit = extractAuditContext(c);
  try {
    const result = await handleDeleteTeamCredential(
      { shared },
      params.provider,
      tenantId,
      params.teamSlug,
    );
    void writeAuditEvent({
      tenantId,
      actor: audit.actor,
      actorUsername: audit.actorUsername,
      action: "revoke_team_cloud_credential",
      outcome: "success",
      target: `${params.provider}:${params.teamSlug}`,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
      occurredAtMs: Date.now(),
    });
    return c.json(result.body, result.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[team-credentials] revoke failed", { provider: params.provider, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/admin/team-cloud-credentials/:provider/:teamSlug", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const params = resolveTeamCredentialParams(c);
  if ("error" in params) return c.json({ error: params.error }, StatusCodes.BAD_REQUEST);
  try {
    const result = await handleGetTeamCredentialStatus(
      { shared },
      params.provider,
      resolveTenantId(c),
      params.teamSlug,
    );
    return c.json(result.body, result.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[team-credentials] status failed", { provider: params.provider, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
