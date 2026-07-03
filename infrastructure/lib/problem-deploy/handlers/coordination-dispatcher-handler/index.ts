import { type Context, Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import {
  type CoordinationHandlerDeps,
  handleCoordinationOp,
  handleCoordinationProjection,
  makeCoordinationScopeResolver,
  parseCoordinationConfig,
} from "../participant-handler/coordination-handler.js";
import type { PluginImporter } from "../participant-handler/coordination-plugin-loader.js";
import {
  type CoordinationTickDeps,
  handleCoordinationTickBatch,
  parseCoordinationTickBatch,
} from "../participant-handler/coordination-tick.js";
import { parseJsonBody, withBearerAuth } from "../participant-handler/route-helpers.js";
import { CoordinationOpBodySchema } from "../participant-handler/schemas.js";
import { buildParticipantSharedResources } from "../participant-handler/shared.js";
import { RATE_LIMITS } from "../shared/rate-limiter.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import { defaultS3PluginImporter } from "./s3-plugin-importer.js";

/**
 * ADR-030 Phase 2 (#1420): inter-team coordination dispatch を participant-portal Lambda から
 * 分離した **専用 Lambda** の Hono app。
 *
 * participant-portal Lambda は AWS Console SSO / CLI 資格情報発行のため `sts:AssumeRole`(競技者
 * federation) + `ssm:GetParameter` + `kms:Decrypt`(ExternalId 復号) を持つ。 そこで未信頼の
 * 問題同梱 coordination plugin を動的実行すると、 1 つの悪性 plugin が競技者アカウントの資格情報・
 * 全テナントデータに到達しうる (ADR-030 S2 の脅威)。 本 Lambda は Deployments テーブルの
 * coordination / team-lookup 行しか触れない最小 IAM で動かし、 blast radius を IAM で構造的に縛る。
 *
 * ADR-030 Phase 3b: importer は `COORDINATION_PLUGIN_BUCKET` が配線されていれば S3 から
 * synth-bundle 済み .mjs を materialize → `import()` する (= 最小 IAM 下での動的 load)。 未配線
 * (= bucket env 空) なら reject し、 load 不可 → `unavailable` / fallback で participant API を壊さない。
 */
const shared = buildParticipantSharedResources();

const pluginBucket = process.env.COORDINATION_PLUGIN_BUCKET ?? "";
const coordinationImporter: PluginImporter = pluginBucket
  ? defaultS3PluginImporter(pluginBucket)
  : (ref) => Promise.reject(new Error(`coordination plugin bucket not configured: ${ref}`));

const coordinationConfig = parseCoordinationConfig(process.env.PROBLEM_COORDINATION);

const coordinationDeps: CoordinationHandlerDeps = {
  importer: coordinationImporter,
  store: { ddb: shared.ddb, tableName: shared.tableName },
  resolveScope: makeCoordinationScopeResolver(shared, coordinationConfig),
};

/**
 * ADR-028 scoring-driven tick (#2324): 採点 Lambda が直接 Invoke する tick batch を、 op 経路と同じ最小
 * IAM の本 Lambda 内で処理するための deps。 importer (S3 materialize) / store (coordination row) は上の
 * op 経路と同一 (= 追加 IAM ゼロ)、 config は宣言 gate に使う。
 */
const tickDeps: CoordinationTickDeps = {
  importer: coordinationImporter,
  store: coordinationDeps.store,
  config: coordinationConfig,
};

/** coordination handler の outcome を HTTP 応答に写す (= StatusCodes 名で意図を明示)。 */
function respondCoordination(
  c: Context,
  outcome: Awaited<ReturnType<typeof handleCoordinationProjection>>,
): Response {
  switch (outcome.kind) {
    case "ok":
      return c.json({ projection: outcome.projection }, StatusCodes.OK);
    case "rejected":
      return c.json({ error: outcome.error }, StatusCodes.UNPROCESSABLE_ENTITY);
    case "conflict":
      return c.json({ error: "conflict" }, StatusCodes.CONFLICT);
    case "unavailable":
      return c.json({ error: "unavailable" }, StatusCodes.SERVICE_UNAVAILABLE);
    default:
      return c.json({ error: "not_configured" }, StatusCodes.NOT_FOUND);
  }
}

const app = new Hono();

// #1694: 全レスポンスに API セキュリティヘッダ (nosniff / no-store / X-Frame-Options /
// Referrer-Policy / JSON Content-Disposition)。
app.use("*", secureApiHeaders());

app.get("/portal/healthz", (c) => c.json({ ok: true }));

// ADR-028 D4/D5 (#1420): 参加者間 coordination の op 提出 + projection polling。
app.post("/portal/me/coordination/op", (c) =>
  withBearerAuth(
    c,
    "coordination-op",
    async (token) => {
      const parsed = await parseJsonBody(c, CoordinationOpBodySchema);
      if (!parsed.ok) return parsed.response;
      const outcome = await handleCoordinationOp(
        coordinationDeps,
        token,
        parsed.data.op,
        new Date().toISOString(),
      );
      return respondCoordination(c, outcome);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

app.get("/portal/me/coordination/projection", (c) =>
  withBearerAuth(
    c,
    "coordination-projection",
    async (token) =>
      respondCoordination(c, await handleCoordinationProjection(coordinationDeps, token)),
    RATE_LIMITS.READ_HIGH,
  ),
);

const honoHandler = handle(app);

/**
 * ADR-028 scoring-driven tick (#2324): Lambda の entry。 採点 Lambda からの直接 Invoke (= tick batch
 * payload) なら plugin の `runTick` を **本 Lambda 内** (= 最小 IAM、 op 経路と同じ場所) で処理する。
 * それ以外 (= Function URL 経由の HTTP event) は従来どおり Hono app へ委譲する (= op / projection 経路は
 * 完全に不変)。 判別は payload 形状 (`parseCoordinationTickBatch`) のみで、 tick 経路は HTTP を通らない
 * (= bearer 認証の対象外、 到達は `lambda:InvokeFunction` を持つ採点 Lambda role に IAM で限定される)。
 */
export const handler = async (event: unknown, context: LambdaContext): Promise<unknown> => {
  const batch = parseCoordinationTickBatch(event);
  if (batch) return handleCoordinationTickBatch(tickDeps, batch);
  return honoHandler(event as LambdaEvent, context);
};

export { app };
