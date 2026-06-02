import { type Context, Hono } from "hono";
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
import { parseJsonBody, withBearerAuth } from "../participant-handler/route-helpers.js";
import { CoordinationOpBodySchema } from "../participant-handler/schemas.js";
import { buildParticipantSharedResources } from "../participant-handler/shared.js";
import { RATE_LIMITS } from "../shared/rate-limiter.js";

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
 * importer は依然 seam (Phase 3 で レビュー済みカタログ bundle の S3 materialize を実装)。 未配線の
 * 間は load 不可 → `unavailable` / fallback projection で participant API を壊さない。
 */
const shared = buildParticipantSharedResources();

const coordinationImporter: PluginImporter = (ref) =>
  Promise.reject(new Error(`coordination plugin importer not configured: ${ref}`));

const coordinationDeps: CoordinationHandlerDeps = {
  importer: coordinationImporter,
  store: { ddb: shared.ddb, tableName: shared.tableName },
  resolveScope: makeCoordinationScopeResolver(
    shared,
    parseCoordinationConfig(process.env.PROBLEM_COORDINATION),
  ),
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

export const handler = handle(app);
export { app };
