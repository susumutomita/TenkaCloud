import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireTenantAdmin,
  resolveCognitoSub,
  resolveTenantId,
} from "../deploy-handler/auth.js";
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
import { DuplicateUserError, TenantMismatchError, UserNotFoundError } from "./users-cognito.js";
import {
  InviteUserRequestSchema,
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
  // Issue #854: role 不一致は 403。 actualRole / requiredRoles は body には出さない
  // (= attacker に attack surface を教えない、 audit log にだけ残す)。
  if (err instanceof ForbiddenRoleError) {
    console.warn("[competitor-accounts] forbidden role", {
      path: c.req.path,
      actualRole: err.actualRole,
      requiredRoles: err.requiredRoles,
    });
    return c.json(
      { error: "forbidden_role", message: "this endpoint requires TenantAdmin role" },
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

// Issue #854: `/admin/*` 全 route で TenantAdmin role を要求する middleware。
// healthz だけは認証無しで通したいので path 比較で skip する (= 認証は API Gateway Cognito
// authorizer で既に通っているが、 healthz は role check 自体を skip する設計)。
// 個別 handler 内で再度 `requireTenantAdmin(c)` を呼ぶ必要は無い (= middleware が gate)。
app.use("/admin/*", async (c, next) => {
  if (c.req.path.endsWith("/healthz")) {
    return next();
  }
  requireTenantAdmin(c);
  return next();
});

app.get("/admin/competitor-accounts/healthz", (c) => c.json({ ok: true }));

// Issue #839 follow-up Phase B: Tenant 管理者が画面 / API から SAML IdP を CRUD する経路。
// 同 Lambda に同居させる (= 同 IAM / auth、 別 handler 化は Phase 3 で再評価)。
app.get("/admin/tenant-saml-config", async (c) => {
  const result = await routeGet({ shared }, c);
  return c.json(result.body as never, result.status as 200);
});
// 互換のため PATCH + PUT 両方受ける (= frontend は PATCH、 curl 直叩き / OpenAPI は PUT で書く)。
app.patch("/admin/tenant-saml-config", async (c) => {
  const result = await routePut({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 400 | 422);
});
app.put("/admin/tenant-saml-config", async (c) => {
  const result = await routePut({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 400 | 422);
});
app.delete("/admin/tenant-saml-config", async (c) => {
  const result = await routeDelete({ shared }, c);
  return c.json(result.body as never, result.status as 200 | 422);
});

app.post("/admin/competitor-accounts", async (c) => {
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
  try {
    const response = await createCompetitorAccount(
      shared,
      {
        tenantId: resolveTenantId(c),
        nowMs: Date.now(),
        createdBy: resolveCognitoSub(c),
      },
      parsed.data,
    );
    return c.json(response, StatusCodes.CREATED);
  } catch (err) {
    if (err instanceof DuplicateCompetitorAccountError) {
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
  const awsAccountId = c.req.param("awsAccountId");
  if (!awsAccountId || !AWS_ACCOUNT_ID_RE.test(awsAccountId)) {
    return c.json({ error: "invalid_account_id" }, StatusCodes.BAD_REQUEST);
  }
  try {
    await deleteCompetitorAccount(shared, resolveTenantId(c), awsAccountId);
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

// Issue #925 Phase 1: Tenant 内 user の CRUD。 `/admin/*` middleware で既に TenantAdmin role が
// gate されているため、 各 handler では tenantId resolve のみ行う。 削除は self-delete 防止 +
// tenant 越境チェック (AdminGetUser) → AdminDeleteUser。
app.get("/admin/users", async (c) => {
  const tenantId = resolveTenantId(c);
  const result = await routeListUsers({ shared }, c, tenantId);
  return c.json(result.body as never, result.status as 200 | 401);
});

app.post("/admin/users", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = InviteUserRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  const tenantId = resolveTenantId(c);
  try {
    const result = await routeCreateUser({ shared }, c, tenantId, parsed.data);
    return c.json(result.body as never, result.status as 201 | 401);
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      return c.json({ error: "duplicate_user", email: err.email }, StatusCodes.CONFLICT);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] user create failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.delete("/admin/users/:username", async (c) => {
  const username = c.req.param("username");
  if (!username || username.length === 0) {
    return c.json({ error: "invalid_username" }, StatusCodes.BAD_REQUEST);
  }
  const tenantId = resolveTenantId(c);
  try {
    const result = await routeDeleteUser({ shared }, c, tenantId, username);
    return c.json(result.body as never, result.status as 200 | 401 | 409);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return c.json({ error: "not_found", username: err.username }, StatusCodes.NOT_FOUND);
    }
    if (err instanceof TenantMismatchError) {
      // 越境試行は 404 で隠蔽 (= attacker に「存在するが他 tenant の user」と教えない)。
      console.warn("[competitor-accounts] tenant mismatch on delete", {
        username,
        expected: err.expectedTenantId,
        actual: err.actualTenantId,
      });
      return c.json({ error: "not_found", username }, StatusCodes.NOT_FOUND);
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[competitor-accounts] user delete failed", { username, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
