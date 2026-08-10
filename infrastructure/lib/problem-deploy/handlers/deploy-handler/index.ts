import { type Context, Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { buildAuthErrorHandler, createRoleCheckMiddleware } from "../shared/auth-wiring.js";
import { ULID_RE as JOB_ID_RE, PROBLEM_ID_RE } from "../shared/constants.js";
import { parseSchema } from "../shared/http-parse.js";
import { createMachineGuardMiddleware } from "../shared/machine-principal.js";
import {
  asCompositeDescriptor,
  type CompositeRuntimeDescriptor,
  EXECUTABLE_PROVIDER,
  RuntimeNotSupportedError,
} from "../shared/runtime/index.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import {
  requireRole,
  requireTenantNotSuspended,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_BLANKET_ROLES,
  TENANT_MACHINE_ROLE,
  TENANT_OPERATOR_ROLE,
} from "./auth.js";
import { CompositeAwsInputRequiredError, startCompositeDeployment } from "./composite-deploy.js";
import { buildCompositeDeployDeps } from "./composite-deploy-wiring.js";
import { requestTeardown } from "./delete.js";
import {
  AwsAccountRequiredError,
  buildContext,
  buildSharedResources,
  type DeployContext,
  NonAwsCredentialUnregisteredError,
  startDeployment,
  UnknownProblemError,
  UnverifiedCompetitorAccountError,
} from "./deploy.js";
import { recordDeployAudit, recordRetryAudit } from "./deploy-audit.js";
import { DeployQuotaExceededError, type QuotaTier, resolveQuotaTier } from "./deploy-quota.js";
import { beginIdempotent, finishIdempotent, hashRequest } from "./idempotency.js";
import { getDeployment, listDeployments } from "./list.js";
import { InvalidRetryRequestError, retryDeployments, validateRetryRequest } from "./retry.js";
import { resolveIdempotencyRepository } from "./shared.js";
import {
  defaultCfnClient,
  defaultCfnClientForCompetitor,
  getStackProgress,
} from "./stack-progress.js";
import { CompositeDeployRequestSchema, DeployRequestSchema } from "./types.js";

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
// [#2527 Slice 4] Composition root: the entrypoint creates the real control-data runtime.
const shared = buildSharedResources(createDefaultControlDataRuntime());

/** `?limit=` query を parse し、不正なら null + 400 レスポンスを返す。 */
function parseLimit(value: string | undefined): { ok: true; limit: number | undefined } | null {
  if (value === undefined) return { ok: true, limit: undefined };
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return null;
  return { ok: true, limit };
}

const app = new Hono();

// #1694: 全レスポンスに API セキュリティヘッダ (nosniff / no-store / X-Frame-Options /
// Referrer-Policy / JSON Content-Disposition)。 CORS より前 (outermost) に置き、 onError
// 経由のエラーレスポンスにも付くようにする。
app.use("*", secureApiHeaders());

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

// #559 defensive layer (詳細は shared/auth-wiring.ts の JSDoc を参照): handler 内 try/catch を
// 漏れた exception を onError で Hono response として返し、CORS middleware を通して
// Access-Control-* headers を付ける (= browser が「Failed to fetch」ではなく body の `error`
// を読める)。`message` は logs だけに残し response body には含めない (PR-570 review)。operator
// は CloudWatch Logs の `[deploy] uncaught handler error` 行で詳細を引く。
app.onError(buildAuthErrorHandler({ logPrefix: "[deploy]" }));

// #2948 / ADR-0005: machine guard は blanket role check **より前** に mount する。allowlist 外の
// route と capability 不足を role 解決の前に落とし、拒否を監査に残すため。human 経路 (=
// `custom:tenantId` claim を持つ ID token) はこの middleware を素通りする。
app.use("*", createMachineGuardMiddleware());

// ADR-020 Phase B.1 (#948): blanket middleware は **「tenant 内のいずれかの role を持つ
// 認証済 user」** であることだけ要求する (= Admin / Operator / Viewer のいずれか)。 各 route の
// 1 行目で `requireRole(c, [...])` を呼び、 destructive 操作には Admin 限定 / mutate には
// Admin + Operator のように **route 単位で** 絞り込む (= Viewer も dropdown populate のため
// GET には pass、 旧 broken-glass 規律で 403 になっていた regression を解消)。
// healthz は authn / authz どちらも skip (= API GW 側で auth bypass 設定)。
// #2948: blanket だけ `TENANT_BLANKET_ROLES` (= human 3 値 + `TenantMachine`) にする。
// per-route の `requireRole` は human 3 値のままなので、machine は allowlist に明示追加した
// route 以外では **この行を通ったあと** に必ず落ちる。
app.use("*", createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_BLANKET_ROLES }));

app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Map a deploy error to its HTTP response. Shared by the legacy single-provider
 * path and the composite path so both surface the same status codes for the
 * quota / unknown-problem / unverified-account / runtime-not-supported cases.
 * The composite path adds `CompositeAwsInputRequiredError` (a 400 validation).
 */
function mapDeployError(c: Context, problemId: string, err: unknown): Response {
  if (err instanceof DeployQuotaExceededError) {
    return c.json(
      {
        error: "deploy_quota_exceeded",
        tier: err.tier,
        limit: err.limit,
        active: err.active,
        message: `同時デプロイ上限 (${err.tier}: ${err.limit}) に達しています。不要な deployment を削除するか、上位 tier を検討してください。`,
      },
      StatusCodes.TOO_MANY_REQUESTS,
    );
  }
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
  // [Issue #2561] The resolved runtime is aws/cloudformation but the request
  // omitted awsAccountId/region. The route's strict DeployRequestSchema
  // already prevents this for a real HTTP request; 400 mirrors
  // CompositeAwsInputRequiredError's semantics (well-formed JSON, missing
  // required input) for the rare direct-caller / test case.
  if (err instanceof AwsAccountRequiredError) {
    return c.json({ error: "aws_input_required", message: err.message }, StatusCodes.BAD_REQUEST);
  }
  // [Issue #2561] No gcp/azure/sakura credential is registered for this team.
  // 422: the request is well-formed (a valid non-AWS single-provider deploy),
  // but the business invariant "the team's provider credential is registered"
  // is not satisfied — same semantics as UnverifiedCompetitorAccountError's
  // AWS-side gate above, just keyed on the provider's own credential store.
  if (err instanceof NonAwsCredentialUnregisteredError) {
    return c.json(
      {
        error: "non_aws_credential_unregistered",
        provider: err.provider,
        teamSlug: err.teamSlug,
        message: `${err.provider} のチームクレデンシャルが未登録です。Competitor Accounts ページで登録してから retry してください。`,
      },
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }
  // [ADR-023 / Issue #1268] Problem metadata declared a runtime we cannot
  // execute today (e.g. azure/bicep). 422: request is well-formed, but the
  // business invariant "platform has an adapter for this provider/engine" is
  // not satisfied. No cloud mutation happens on this path.
  if (err instanceof RuntimeNotSupportedError) {
    return c.json(
      {
        error: "runtime_not_supported",
        provider: err.runtime.provider,
        engine: err.runtime.engine,
        message: err.message,
      },
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }
  // [Composite Runtime / Issue #2075] The composite plan has an AWS target but
  // the request omitted awsAccountId/region → 400 (a request-validation gap).
  if (err instanceof CompositeAwsInputRequiredError) {
    return c.json({ error: "aws_input_required", message: err.message }, StatusCodes.BAD_REQUEST);
  }
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[deploy] startDeployment failed", { problemId, message });
  return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
}

/**
 * [Composite Runtime / Issue #2075] Composite deploy branch. The body is parsed
 * with the composite schema (awsAccountId/region optional — the plan decides if
 * AWS is needed). Tenant authorization (role + not-suspended) already ran at the
 * route entry; the deploy quota is enforced ONCE for the whole parent inside
 * `startCompositeDeployment` (never once per target). The response reuses the
 * existing single-provider shape with the parent deployment id as jobId.
 */
async function handleCompositeDeploy(
  c: Context,
  ctx: DeployContext,
  problemId: string,
  descriptor: CompositeRuntimeDescriptor,
  quotaTier: QuotaTier,
  body: unknown,
): Promise<Response> {
  const parsed = parseSchema(c, CompositeDeployRequestSchema, body);
  if (!parsed.ok) return parsed.response;
  try {
    const response = await startCompositeDeployment(
      buildCompositeDeployDeps(ctx, parsed.data.teamName),
      { ...parsed.data, problemId, descriptor, quotaTier },
    );
    return c.json(response, StatusCodes.ACCEPTED);
  } catch (err) {
    return mapDeployError(c, problemId, err);
  }
}

app.post("/problems/:problemId/deploy", async (c) => {
  // #2948: machine principal が到達できる **唯一の mutating route**。`TENANT_MACHINE_ROLE` を
  // per-route allowlist に足すのはここ 1 箇所だけで、test `machine-role-allowlist-sites` が
  // source-level でその数を pin する。
  requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE, TENANT_MACHINE_ROLE]);
  const problemId = c.req.param("problemId");
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
    return c.json({ error: "invalid_problem_id" }, StatusCodes.BAD_REQUEST);
  }
  requireTenantNotSuspended(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
  }

  const tenantId = resolveTenantId(c);

  // [Issue #3002] Idempotency-Key。 ヘッダが無ければ従来どおり素通りする (後方互換)。
  // deploy はレスポンスまで時間がかかるので、 タイムアウト後の再送でスタックが 2 つ
  // できるのを止めるのがここの目的。
  //
  // ヘッダが無いときは storage を一切触らない。 resolver を呼ぶだけでも backend への
  // 往復が増えるので、 既存クライアント (= 大多数) の経路は従来と同じままにする。
  const idempotencyKey = c.req.header("Idempotency-Key");
  // 結果の記録は 1 つの closure に閉じ込める。 分岐先 (composite / 単一 / 失敗) ごとに
  // `if (idempotency)` を書くと、 同じ条件が 3 箇所へ散り、 1 つ書き忘れるとその経路だけ
  // 再送で二重に走る。
  let recordIdempotentResult: (status: number, resultBody: unknown) => Promise<void> = async () =>
    undefined;
  if (idempotencyKey !== undefined) {
    const repository = await resolveIdempotencyRepository(shared);
    const decision = await beginIdempotent({
      repository,
      tenantId,
      key: idempotencyKey,
      requestHash: hashRequest(problemId, body),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (decision.kind === "respond") {
      return c.json(decision.body as Record<string, unknown>, decision.status as 200);
    }
    recordIdempotentResult = (status, resultBody) =>
      finishIdempotent({
        repository,
        tenantId,
        key: decision.key,
        status,
        body: resultBody,
      });
  }

  const ctx = buildContext(shared, tenantId);
  // #1766: quota tier は JWT claim から route で解決し、enforcement 自体は
  // startDeployment / startCompositeDeployment 内で行う (PR-1803 review)。
  const quotaTier = resolveQuotaTier(c);

  // [Composite Runtime / Issue #2075] Detect a composite problem from catalog
  // runtime metadata BEFORE any write. Only a `runtime.kind=composite` problem
  // forks here; every legacy / single-provider problem (descriptor undefined or
  // single) falls through to the byte-identical `startDeployment` path below.
  const descriptor = ctx.resolveProblemRuntimeDescriptor?.(problemId);
  const composite = asCompositeDescriptor(descriptor);
  if (composite) {
    const response = await handleCompositeDeploy(c, ctx, problemId, composite, quotaTier, body);
    await recordDeployAudit(
      c,
      tenantId,
      problemId,
      response.status === StatusCodes.ACCEPTED ? "success" : "error",
    );
    // composite も同じ route なので、 記録しないとここだけ再送で二重に走る。
    await recordIdempotentResult(response.status, await response.clone().json());
    return response;
  }

  // [Issue #2561] A non-AWS single-provider problem (gcp/azure/sakura) needs
  // neither awsAccountId nor region — parse with the same relaxed shape the
  // composite path already uses (`CompositeDeployRequestSchema`) instead of
  // the strict AWS-only `DeployRequestSchema`, so the request does not 400
  // before `startDeployment` even gets a chance to skip the AWS-account gate.
  const runtime = ctx.resolveProblemRuntime?.(problemId);
  const isNonAwsSingleProvider = runtime !== undefined && runtime.provider !== EXECUTABLE_PROVIDER;
  const parsed = parseSchema(
    c,
    isNonAwsSingleProvider ? CompositeDeployRequestSchema : DeployRequestSchema,
    body,
  );
  if (!parsed.ok) return parsed.response;

  try {
    const response = await startDeployment(ctx, {
      ...parsed.data,
      problemId,
      quotaTier,
    });
    await recordDeployAudit(c, tenantId, problemId, "success");
    await recordIdempotentResult(StatusCodes.ACCEPTED, response);
    return c.json(response, StatusCodes.ACCEPTED);
  } catch (err) {
    await recordDeployAudit(c, tenantId, problemId, "error");
    const failure = mapDeployError(c, problemId, err);
    // 失敗も記録する。 Stripe と同じで、 同じキーの再送には成功・失敗を問わず 1 回目の
    // 結果を返す。 失敗を記録しないと、 再送のたびに実処理が走ってしまう。
    await recordIdempotentResult(failure.status, await failure.clone().json());
    return failure;
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
  // #2955 Phase 2: machine principal に開く 2 本目の mutating route。`retry.ts` が publish する
  // のは `DeployCreateRequested` だけで、deploy route と同じ pipeline に閉じている
  // (= scheduler / reconciler へは届かない)。root cause は `MACHINE_ROUTE_SCOPES` の
  // `reachability` field に宣言してある。
  requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE, TENANT_MACHINE_ROLE]);
  requireTenantNotSuspended(c);
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
  const retryTenantId = resolveTenantId(c);
  try {
    const result = await retryDeployments(shared, retryTenantId, request);
    // #2955: 再投入は deploy と同じく mutating なので、同じ粒度で監査に残す。
    await recordRetryAudit(c, retryTenantId, result.items.length, "success");
    return c.json(result, StatusCodes.OK);
  } catch (err) {
    await recordRetryAudit(c, retryTenantId, request.failedJobIds.length, "error");
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
