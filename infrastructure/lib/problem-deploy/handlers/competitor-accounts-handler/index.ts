import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { resolveCognitoSub, resolveTenantId } from "../deploy-handler/auth.js";
import { buildCompetitorAccountsSharedResources } from "./shared.js";
import {
  CompetitorAccountNotFoundError,
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
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[competitor-accounts] uncaught handler error", {
    path: c.req.path,
    message,
  });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

app.get("/admin/competitor-accounts/healthz", (c) => c.json({ ok: true }));

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
    console.log(
      JSON.stringify({
        event: "competitor-accounts.rotate",
        tenantId,
        awsAccountId,
        rotatedBy,
        rotatedAt: response.rotatedAt,
      }),
    );
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CompetitorAccountNotFoundError) {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
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

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
