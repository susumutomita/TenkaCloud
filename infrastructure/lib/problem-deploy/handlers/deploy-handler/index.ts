import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { ULID_RE as JOB_ID_RE, PROBLEM_ID_RE } from "../shared/constants.js";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
  TENANT_ROLES,
} from "./auth.js";
import { requestTeardown } from "./delete.js";
import {
  buildContext,
  buildSharedResources,
  startDeployment,
  UnknownProblemError,
  UnverifiedCompetitorAccountError,
} from "./deploy.js";
import { getDeployment, listDeployments } from "./list.js";
import { InvalidRetryRequestError, retryDeployments, validateRetryRequest } from "./retry.js";
import {
  defaultCfnClient,
  defaultCfnClientForCompetitor,
  getStackProgress,
} from "./stack-progress.js";
import { DeployRequestSchema } from "./types.js";

/**
 * Deploy API Lambda の Hono app。routes:
 *   POST   /problems/:problemId/deploy
 *   GET    /problems/:problemId/deployments
 *   GET    /deployments/:jobId
 *   DELETE /deployments/:jobId
 *
 * Auth: 本番経路は API Gateway HTTP API + Cognito JWT authorizer で、tenantId は
 * JWT の `custom:tenantId` claim から取り出す。Function URL (AWS_IAM) は ops 用に
 * 残しており、その経路では `DEFAULT_TENANT_ID` env にフォールバック。
 */

const LIST_LIMIT_MAX = 200;

// SDK clients / env を module scope で 1 度だけ build。warm invoke で connection pool 再利用。
const shared = buildSharedResources();

/** `?limit=` query を parse し、不正なら null + 400 レスポンスを返す。 */
function parseLimit(value: string | undefined): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

const app = new Hono();

// CORS は本 Lambda 側で打つ (= API Gateway の defaultCorsPreflightOptions は OPTIONS のみ
// 対応で、実 POST/GET レスポンスには Access-Control-Allow-Origin が付かないため)。
// Cognito JWT は Authorization header で送られるので credentials cookie は使わず、`*`
// で許可する。Phase 2 で tenant の CloudFront URL に絞る。
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
// の `[deploy] uncaught handler error` 行で詳細を引く。
app.onError((err, c) => {
  // Issue #686: JWT に custom:tenantId が無い場合は 401 で fail-closed (= silent
  // "unknown-tenant" 書き込みを防ぐ)。 caller (frontend) は FriendlyErrorAlert で
  // 「再ログインしてください」 を表示する。
  if (err instanceof MissingTenantClaimError) {
    console.warn("[deploy] missing tenantId claim", { path: c.req.path });
    return c.json(
      { error: "missing_tenant_claim", message: err.message },
      StatusCodes.UNAUTHORIZED,
    );
  }
  // Issue #854 / ADR-020 Phase B.1 (#948): role 不一致は 403、 detail は body に出さず log のみ
  // (= attacker に attack surface を教えない)。 frontend は error code "forbidden_role" を
  // FriendlyErrorAlert にマップする。
  if (err instanceof ForbiddenRoleError) {
    console.warn("[deploy] forbidden role", {
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
  console.error("[deploy] uncaught handler error", { path: c.req.path, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
});

// ADR-020 Phase B.1 (#948): blanket middleware は **「tenant 内のいずれかの role を持つ
// 認証済 user」** であることだけ要求する (= Admin / Operator / Viewer のいずれか)。 各 route の
// 1 行目で `requireRole(c, [...])` を呼び、 destructive 操作には Admin 限定 / mutate には
// Admin + Operator のように **route 単位で** 絞り込む (= Viewer も dropdown populate のため
// GET には pass、 旧 broken-glass 規律で 403 になっていた regression を解消)。
// healthz は authn / authz どちらも skip (= API GW 側で auth bypass 設定)。
app.use("*", async (c, next) => {
  if (c.req.path === "/healthz" || c.req.path.endsWith("/healthz")) {
    return next();
  }
  requireRole(c, TENANT_ROLES);
  return next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/problems/:problemId/deploy", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid_problem_id" }, StatusCodes.BAD_REQUEST);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }

  const parsed = DeployRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }

  const ctx = buildContext(shared, resolveTenantId(c));

  try {
    const response = await startDeployment(ctx, { ...parsed.data, problemId });
    return c.json(response, StatusCodes.ACCEPTED);
  } catch (err) {
    if (err instanceof UnknownProblemError) {
      return c.json({ error: "unknown_problem", problemId }, StatusCodes.NOT_FOUND);
    }
    // Phase 2.2 (Issue #459): verified=true 行が無い account への deploy は 422 (semantically
    // 適切: request 自体は well-formed だが、business invariant が満たされない)。operator は
    // CompetitorAccounts ページで verify を済ませてから retry する。
    if (err instanceof UnverifiedCompetitorAccountError) {
      return c.json(
        {
          error: "unverified_competitor_account",
          awsAccountId: err.awsAccountId,
          message:
            "AWS Account ID が CompetitorAccounts table で verified=true 状態でないため deploy できません。",
        },
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] startDeployment failed", { problemId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/problems/:problemId/deployments", async (c) => {
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid_problem_id" }, StatusCodes.BAD_REQUEST);
  }
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  try {
    const response = await listDeployments(shared, {
      tenantId: resolveTenantId(c),
      problemId,
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] listDeployments failed", { problemId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/deployments", async (c) => {
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  try {
    const response = await listDeployments(shared, {
      tenantId: resolveTenantId(c),
      limit: parsedLimit.limit,
      cursor: c.req.query("cursor"),
    });
    return c.json(response, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] listDeployments(tenant-wide) failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.get("/deployments/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid_job_id" }, StatusCodes.BAD_REQUEST);
  }
  try {
    const item = await getDeployment(shared, resolveTenantId(c), jobId);
    if (!item) return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    return c.json(item, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] getDeployment failed", { jobId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

// #534: CFn StackEvents / StackResources / console deep link を返す。
// `getDeployment` と分離する理由は:
//   - DDB 行は即返せるのに対し CFn API は ~300ms × 2 で遅い (= 別 endpoint で 5 秒 polling)
//   - CFn API throttle / 権限不足は detail page の基本情報まで道連れにしない
app.get("/deployments/:jobId/stack-progress", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid_job_id" }, StatusCodes.BAD_REQUEST);
  }
  try {
    const outcome = await getStackProgress(
      shared,
      { cfnClient: defaultCfnClient, cfnClientForCompetitor: defaultCfnClientForCompetitor },
      resolveTenantId(c),
      jobId,
    );
    if (outcome.kind === "not_found") {
      return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    }
    if (outcome.kind === "stack_not_yet_created") {
      // CFn stack 未割当 (= deploy 進行極初期) は 409 で返し、UI 側で「準備中」表示にする。
      // 200 + 空 events で返す案もあるが、不在を error 型で明示した方が UI 分岐がしやすい。
      return c.json({ error: "stack_not_yet_created" }, StatusCodes.CONFLICT);
    }
    if (outcome.kind === "stack_not_found_in_cfn") {
      // CFn API が「stack なし」を返したケース (= 削除済 / 未作成 race)。events / resources
      // は空、console URL のみ提供して operator が手動確認可能にする。
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
    console.error("[deploy] getStackProgress failed", { jobId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

/**
 * Issue #911 (#895 Phase 2.D): bulk batch で FAILED になった item の jobId 配列を再投入する
 * idempotent retry API。 caller の tenantId scope に閉じ、 FAILED row のみ PENDING に
 * 巻き戻して event 再 publish。 成功済 / in-progress / 別 tenant の row は skip して結果に
 * 含める (= partial success を一括 response で表現)。
 *
 * 入力: \`{ failedJobIds: ["01HX...", ...] }\`、 最大 750 件
 * 出力: \`{ items: [{ jobId, action: \"requeued\" | \"skipped\", reason? }, ...] }\`
 */
app.post("/deployments/retry", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }
  let request: ReturnType<typeof validateRetryRequest>;
  try {
    request = validateRetryRequest(body);
  } catch (err) {
    if (err instanceof InvalidRetryRequestError) {
      return c.json({ error: "invalid_request", message: err.message }, StatusCodes.BAD_REQUEST);
    }
    throw err;
  }
  try {
    const result = await retryDeployments(shared, resolveTenantId(c), request);
    return c.json(result, StatusCodes.OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] retryDeployments failed", { message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

app.delete("/deployments/:jobId", async (c) => {
  requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
  const jobId = c.req.param("jobId");
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return c.json({ error: "invalid_job_id" }, StatusCodes.BAD_REQUEST);
  }
  try {
    const outcome = await requestTeardown(shared, resolveTenantId(c), jobId, Date.now());
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
    if (outcome.kind === "already_deleted") {
      return c.json({ status: "already_deleted" }, StatusCodes.OK);
    }
    if (outcome.kind === "race") return c.json({ error: "conflict" }, StatusCodes.CONFLICT);
    if (outcome.kind === "missing_required_fields") {
      return c.json(
        { error: "missing_required_fields", fields: outcome.fields },
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
    return c.json(
      { status: "accepted", previousStatus: outcome.previousStatus },
      StatusCodes.ACCEPTED,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[deploy] requestTeardown failed", { jobId, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
