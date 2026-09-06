import { S3Client } from "@aws-sdk/client-s3";
import { type Context, Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import {
  type CoordinationArtifactStore,
  UnconfiguredCoordinationArtifactStore,
} from "../../control-data/coordination-artifact-store.js";
import { S3CoordinationArtifactStore } from "../../control-data/s3-coordination-artifact-store.js";
import {
  type CoordinationHandlerDeps,
  handleCoordinationArtifactFetch,
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
import {
  createCoordinationControlDataRuntime,
  createCoordinationDdbClient,
} from "./coordination-backends.js";
import { defaultS3PluginImporter } from "./s3-plugin-importer.js";

/**
 * Issue #1420: inter-team coordination dispatch を participant-portal Lambda から
 * 分離した **専用 Lambda** の Hono app。
 *
 * participant-portal Lambda は AWS Console SSO / CLI 資格情報発行のため `sts:AssumeRole`(競技者
 * federation) + `ssm:GetParameter` + `kms:Decrypt`(ExternalId 復号) を持つ。本 Lambda へ分離することで
 * plugin からそれらの資格情報を外す。ただし DynamoDB backend の role は Deployments table 全体への
 * Query / GetItem / PutItem を許可し、tenant ごとの IAM isolation はない。動的実行するのはレビュー済み
 * catalog bundle の trusted plugin に限り、catalog review と publish control を trust boundary とする。
 *
 * importer は `COORDINATION_PLUGIN_BUCKET` が配線されていれば S3 から
 * synth-bundle 済み .mjs を materialize → `import()` する。未配線
 * (= bucket env 空) なら reject し、 load 不可 → `unavailable` / fallback で participant API を壊さない。
 */
// One control-data runtime is shared for the Lambda instance lifetime (#2527).
const shared = buildParticipantSharedResources(
  createCoordinationControlDataRuntime(),
  createCoordinationDdbClient(),
);

const pluginBucket = process.env.COORDINATION_PLUGIN_BUCKET ?? "";
const coordinationImporter: PluginImporter = pluginBucket
  ? defaultS3PluginImporter(pluginBucket)
  : (ref) => Promise.reject(new Error(`coordination plugin bucket not configured: ${ref}`));

const coordinationConfig = parseCoordinationConfig(process.env.PROBLEM_COORDINATION);

/**
 * [Issue #3152] Where immutable submission bodies live.
 *
 * A deployment with no bucket gets the unconfigured store, which REFUSES an
 * operation carrying a body rather than accepting it and dropping the bytes.
 * Silently discarding would leave the plugin's state referencing artifacts that
 * were never stored, and the failure would surface much later as a participant
 * fetching a proof that does not exist.
 */
const artifactBucket = process.env.COORDINATION_ARTIFACT_BUCKET ?? "";
const coordinationArtifacts: CoordinationArtifactStore = artifactBucket
  ? new S3CoordinationArtifactStore({ s3: new S3Client({}), bucket: artifactBucket })
  : new UnconfiguredCoordinationArtifactStore();

const coordinationDeps: CoordinationHandlerDeps = {
  importer: coordinationImporter,
  store: { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
  resolveScope: makeCoordinationScopeResolver(shared, coordinationConfig),
  artifacts: coordinationArtifacts,
};

/**
 * Issue #2324: 採点 Lambda が直接 Invoke する tick batch を op 経路と同じ dispatcher role で
 * 処理するための deps。importer (S3 materialize) / store (coordination row) は上の op 経路と同一
 * (= 追加 IAM ゼロ)、config は宣言 gate に使う。
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
    // [Issue #3125] 候補が複数で problemId 省略。 どれかを勝手に選ぶと 2 問目が永久に
    // 到達不能になるので、 候補を返して選ばせる。 `default` に落とすと 404
    // (`not_configured`) に化けて「問題が無い」と嘘をつくことになる。
    case "ambiguous":
      return c.json(
        { error: "ambiguous_problem", problemIds: outcome.problemIds },
        StatusCodes.CONFLICT,
      );
    // [Issue #3150] `unavailable` とは別の error 文字列にする -- 運営が「plugin が
    // 全く load できない」と「plugin は load できたが行の版と噛み合わない」を区別できるように。
    // `default` に落とすと 404 (`not_configured`) に化け、 Issue が最も嫌う「静かに壊れる」を
    // HTTP 層で再生産することになる。
    case "schema_mismatch":
      return c.json(
        { error: "state_schema_mismatch", reason: outcome.reason },
        StatusCodes.SERVICE_UNAVAILABLE,
      );
    // [Issue #3151] 507: 参加者の要求そのものは正しく、 受け入れられない理由は保存先に
    // 空きが無いことにある。 413 (Payload Too Large) は「送ってきた request が大きい」の
    // 意味なので当たらない -- 大きいのは request ではなく、 その op を適用した後の試合の
    // state で、 これは参加者が小さくできるものではない。
    //
    // 数値は返す。 運営が「どこまで来ているか」を participant 側の報告からも掴めるように
    // する必要があるし、 予算そのものは秘密ではない (試合の中身は載せない)。
    case "too_large":
      return c.json(
        {
          error: "state_over_budget",
          bytes: outcome.bytes,
          maxBytes: outcome.budget.maxBytes,
          backend: outcome.budget.backend,
        },
        StatusCodes.INSUFFICIENT_STORAGE,
      );
    // [Issue #3170] Progression Gate 未完了。 403 -- 要求は正しく、 認証も通っており、
    // 拒否の理由は「まだその問題を開けていない」ことにある。 404 (`not_configured`) へ
    // 落とすと「その問題は無い」と嘘をつくことになり、 参加者は Gate を完了しても
    // 何も変わらないと解釈する。 `gateProblemId` を返すのは、 portal が
    // 「先に hello-world を完了してください」の導線を出せるようにするため。
    case "locked":
      return c.json(
        { error: "challenge_prerequisite_not_met", gateProblemId: outcome.gateProblemId },
        StatusCodes.FORBIDDEN,
      );
    default:
      return c.json({ error: "not_configured" }, StatusCodes.NOT_FOUND);
  }
}

const app = new Hono();

// #1694: 全レスポンスに API セキュリティヘッダ (nosniff / no-store / X-Frame-Options /
// Referrer-Policy / JSON Content-Disposition)。
app.use("*", secureApiHeaders());

app.get("/portal/healthz", (c) => c.json({ ok: true }));

// Issue #1420: 参加者間 coordination の op 提出 + projection polling。
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
        parsed.data.problemId,
        parsed.data.artifacts,
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
      respondCoordination(
        c,
        // [Issue #3125] GET なので query から。 省略時の挙動は従来どおり。
        await handleCoordinationProjection(
          coordinationDeps,
          token,
          c.req.query("problemId") || undefined,
        ),
      ),
    RATE_LIMITS.READ_HIGH,
  ),
);

/**
 * [Issue #3152] Fetches one immutable artifact body.
 *
 * Separate from the projection on purpose. The projection is polled constantly
 * and carries references only, which is what keeps a poll from turning into N
 * object reads; the body is fetched at the moment a participant acts on it —
 * `ac26-crypto-battle`'s HUNT reads the shares it is actually hunting.
 *
 * Authorized by that same projection: if the reference is on your board you may
 * read what it points at, and if it is not, the artifact does not exist as far
 * as you are concerned. That is why a missing artifact and an unauthorized one
 * are the same 404 — distinguishing them would let a participant probe which
 * ids exist in a match they cannot see.
 */
app.get("/portal/me/coordination/artifact/:artifactId", (c) =>
  withBearerAuth(
    c,
    "coordination-artifact",
    async (token) => {
      const artifactId = c.req.param("artifactId");
      if (!artifactId) return c.json({ error: "artifact_id_required" }, StatusCodes.BAD_REQUEST);
      const outcome = await handleCoordinationArtifactFetch(
        coordinationDeps,
        token,
        artifactId,
        c.req.query("problemId") || undefined,
      );
      if (outcome.kind === "ok") {
        // Returned as bytes rather than as JSON: these are proofs, ciphertexts
        // and transcripts, and re-encoding them would inflate every fetch by a
        // third for no one's benefit.
        return c.body(outcome.artifact.content as unknown as ArrayBuffer, StatusCodes.OK, {
          "content-type": outcome.artifact.ref.contentType,
          "content-length": String(outcome.artifact.ref.bytes),
          // Lets a participant verify they received the bytes the match
          // recorded, without a second request.
          "x-tenkacloud-artifact-digest": outcome.artifact.ref.digest,
        });
      }
      if (outcome.kind === "not_found") {
        return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
      }
      return respondCoordination(c, outcome);
    },
    RATE_LIMITS.READ_HIGH,
  ),
);

const honoHandler = handle(app);

/**
 * Issue #2324: Lambda の entry。採点 Lambda からの直接 Invoke (tick batch payload) なら plugin の
 * `runTick` を **本 Lambda 内** (= op 経路と同じ role) で処理する。
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
