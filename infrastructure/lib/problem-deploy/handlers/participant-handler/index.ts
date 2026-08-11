import { type Context, Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";
import {
  deleteProblemEndpointOverride,
  listProblemEndpoints,
  upsertProblemEndpointOverride,
} from "../problem-endpoints-handler/endpoints.js";
import { RATE_LIMITS } from "../shared/rate-limiter.js";
import { secureApiHeaders } from "../shared/secure-headers.js";
import { BATTLE_ATTACKS_SINCE_MIN_DEFAULT, listBattleAttacks } from "./battle-attacks.js";
import { castEvent, INBOX_SINCE_MS_MAX, readInbox } from "./cast-event.js";
import { getJobPrerequisiteBlock, type PrerequisiteBlock } from "./challenge-access.js";
import {
  bridgeCompositeCliCredentials,
  bridgeCompositeConsoleSignin,
  type CompositeAwsAccessBridgeDeps,
} from "./composite-aws-access-bridge.js";
import {
  defaultDeployLogDeps,
  getParticipantDeployLogs,
  parseDeployLogLimit,
} from "./deploy-logs.js";
import { getLeaderboard } from "./leaderboard.js";
import { getLeaderboardScoreEvents } from "./leaderboard-score-events.js";
import { lookupTeamByLoginKey } from "./lookup.js";
import { listNotifications, NOTIFICATIONS_DEFAULT_LIMIT } from "./notifications.js";
import { revealHint } from "./reveal-hint.js";
import {
  parseJsonBody,
  parseParams,
  parseQuery,
  respondError,
  withBearerAuth,
} from "./route-helpers.js";
import {
  BattleAttacksQuerySchema,
  CastEventBodySchema,
  CompositeTargetAccessParamSchema,
  DeployLogsQuerySchema,
  EventInboxQuerySchema,
  NotificationsQuerySchema,
  PatchMeBodySchema,
  ProblemHintParamSchema,
  ProblemIdParamSchema,
  ProblemSlotParamSchema,
  SsoQuerySchema,
  SubmitFlagBodySchema,
  UpsertEndpointBodySchema,
} from "./schemas.js";
import { listScoreEvents } from "./score-events.js";
import { buildParticipantSharedResources } from "./shared.js";
import { getCliCredentials, getConsoleSigninUrl } from "./sso.js";
import { submitFlag } from "./submit-flag.js";
import { setDisplayTeamName } from "./update.js";

/**
 * Participant Portal backend Lambda の Hono app (Phase 2c で team scope)。routes:
 *   GET   /portal/healthz
 *   GET   /portal/leaderboard           — event scope の team ランキング
 *   GET   /portal/me/score-events       — 自チームの加点履歴 (時系列降順)
 * GET /portal/me/notifications — 自 event 宛の運営通知 (時系列降順)
 *   GET   /portal/me                    — Authorization: Bearer <teamLoginKey>
 *                                         → { team, problems[] }
 *   GET   /portal/me/console-signin-url — AWS Console federation login URL 発行
 *   GET   /portal/me/cli-credentials    — Issue #1197: CLI / SDK 用一時資格情報を発行 (= 同 AssumeRole chain、 federation endpoint 不要)
 *   GET   /portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/console-signin-url
 *                                       — Issue #2077: composite AWS target の Console 発行 (= 既存 SSO へ委譲)
 *   GET   /portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/cli-credentials
 *                                       — Issue #2077: composite AWS target の CLI 資格情報 (= 既存 CLI へ委譲)
 *   PATCH /portal/me                    — body: { teamName: string }
 *   POST  /portal/me/submit-flag        — body: { problemId: string, flag: string }
 *
 * Function URL は `AuthType=NONE` で公開し、`teamLoginKey` 自体を bearer として
 * Lambda 内で検証する。ボイラープレート (token 抽出 / 500 ハンドリング / outcome→HTTP)
 * は `route-helpers.ts` に集約。 Issue #1242 以降、 body / query / path-param は
 * `participant-handler/schemas.ts` の zod schema 経由で全 route 統一 validate する。
 */
// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance,
// shared by the participant seams and the composite AWS-access bridge below.
const controlDataRuntime = createDefaultControlDataRuntime();
const shared = buildParticipantSharedResources(controlDataRuntime);

// [Composite Runtime / Issue #2077] Repository deps for the composite-target AWS
// access bridge. The participant Lambda already holds the Deployments table
// client; the bridge reuses it to resolve a team-scoped target via GSI3 and then
// delegates to the existing AWS Console / CLI functions (no new IAM grant).
const compositeAwsAccessDeps: CompositeAwsAccessBridgeDeps = {
  repo: { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
};

// Issue #1420: inter-team coordination の op/projection route は専用の最小 IAM
// CoordinationDispatcherLambda (coordination-dispatcher-handler) へ分離した。 participant-portal
// Lambda は sts:AssumeRole / ssm / kms を持つため、 未信頼 plugin を実行する coordination は
// ここに置かない (blast radius を IAM で封じる)。
const app = new Hono();

// #1694: 全レスポンスに API セキュリティヘッダ (nosniff / no-store / X-Frame-Options /
// Referrer-Policy / JSON Content-Disposition)。 fetch/XHR では Content-Disposition は無視
// されるため SPA は壊れず、 cli-credentials 等の機密 JSON が no-store になる。
app.use("*", secureApiHeaders());

/**
 * Issue #2283: `challenge_prerequisite_not_met` の共通 responder。 UI が
 * 「先に <gateProblemId> を完了」 誘導を出せるよう gateProblemId を body に含める
 * (scoring_not_started + startsAt と同 pattern)。 5+ route が同じ mapping を使うので集約。
 */
function respondPrerequisiteBlock(c: Context, block: PrerequisiteBlock) {
  return respondError(c, block.kind, { gateProblemId: block.gateProblemId });
}

app.get("/portal/healthz", (c) => c.json({ ok: true }));

app.get("/portal/me", (c) =>
  withBearerAuth(c, "lookup", async (token) => {
    const view = await lookupTeamByLoginKey(shared, token);
    if (!view) return respondError(c, "unauthorized");
    return c.json(view, StatusCodes.OK);
  }),
);

app.get("/portal/me/score-events", (c) =>
  withBearerAuth(c, "score-events", async (token) => {
    const outcome = await listScoreEvents(shared, token);
    if (outcome.kind === "unauthorized") return respondError(c, "unauthorized");
    return c.json(outcome.response, StatusCodes.OK);
  }),
);

app.get("/portal/me/console-signin-url", (c) =>
  withBearerAuth(c, "sso", async (token) => {
    const q = parseQuery(c, SsoQuerySchema);
    if (!q.ok) return q.response;
    // Issue #2283: locked challenge の stack へ Console access させない (先行着手防止)。
    const prerequisite = await getJobPrerequisiteBlock(shared, token, q.data.jobId);
    if (prerequisite) return respondPrerequisiteBlock(c, prerequisite);
    const outcome = await getConsoleSigninUrl(shared, token, q.data.jobId);
    if (outcome.kind === "ok") return c.json({ loginUrl: outcome.loginUrl }, StatusCodes.OK);
    if (outcome.kind === "assume_role_failed") {
      // Issue #1197: 500 body に stage / reason を含める (= UI が 「どちらの段で / なぜ
      // 落ちたか」 を表示できる)。 機微情報 (= ARN や ExternalId 値) は含めない、 種別のみ。
      return respondError(c, outcome.kind, { stage: outcome.stage, reason: outcome.reason });
    }
    return respondError(c, outcome.kind);
  }),
);

/**
 * Issue #1197: CLI / SDK 用一時資格情報。 Console federation と同じ 2 段 AssumeRole で発行
 * した credentials を JSON で返す。 IAM scope は Console と同一 (= ParticipantViewerRole)。
 *
 * rate limit: WRITE_LOW — 「credentials 発行」 は 1 セッション 1 回相当の希少 operation、
 * brute force 標的にもなり得るので submit-flag より緩めに 12 req/min で絞る。
 */
app.get("/portal/me/cli-credentials", (c) =>
  withBearerAuth(
    c,
    "cli-credentials",
    async (token) => {
      const q = parseQuery(c, SsoQuerySchema);
      if (!q.ok) return q.response;
      // Issue #2283: locked challenge の stack へ CLI credentials を発行しない。
      const prerequisite = await getJobPrerequisiteBlock(shared, token, q.data.jobId);
      if (prerequisite) return respondPrerequisiteBlock(c, prerequisite);
      const outcome = await getCliCredentials(shared, token, q.data.jobId);
      if (outcome.kind === "ok")
        return c.json({ credentials: outcome.credentials }, StatusCodes.OK);
      if (outcome.kind === "assume_role_failed") {
        return respondError(c, outcome.kind, { stage: outcome.stage, reason: outcome.reason });
      }
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

/**
 * [Composite Runtime / Issue #2077] Composite-target AWS access bridge routes.
 *
 *   GET /portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/console-signin-url
 *   GET /portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/cli-credentials
 *
 * A READY AWS target inside a Composite parent reuses the EXISTING participant
 * Console federation + CLI credential issuance. The path ids are consumed ONLY as
 * a lookup key: the bridge resolves the team-scoped target server-side (GSI3 +
 * the #2076 capability contract), verifies it is a COMPLETE AWS target, and then
 * delegates to the same functions the legacy single-provider routes use. A non-
 * AWS target is rejected as `capability_mismatch` (409) and STS is never called;
 * a cross-team / missing target is `not_found` (404); a not-COMPLETE target is
 * `not_ready` (400). No role ARN / account id is ever accepted from the client.
 *
 * Rate limit mirrors the legacy `cli-credentials` route (WRITE_LOW) — credential
 * / sign-in issuance is a rare per-session operation and a brute-force target.
 */
app.get(
  "/portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/console-signin-url",
  (c) =>
    withBearerAuth(
      c,
      "composite-console-signin",
      async (token) => {
        const params = parseParams(c, CompositeTargetAccessParamSchema);
        if (!params.ok) return params.response;
        // Issue #2283: composite parent (= catalog 上の問題) が locked なら target への
        // AWS access も発行しない (parentDeploymentId = 親 deployment の jobId)。
        const prerequisite = await getJobPrerequisiteBlock(
          shared,
          token,
          params.data.parentDeploymentId,
        );
        if (prerequisite) return respondPrerequisiteBlock(c, prerequisite);
        const outcome = await bridgeCompositeConsoleSignin(shared, compositeAwsAccessDeps, {
          teamLoginKey: token,
          parentDeploymentId: params.data.parentDeploymentId,
          targetDeploymentId: params.data.targetDeploymentId,
        });
        if (outcome.kind === "ok") return c.json({ loginUrl: outcome.loginUrl }, StatusCodes.OK);
        if (outcome.kind === "assume_role_failed") {
          return respondError(c, outcome.kind, { stage: outcome.stage, reason: outcome.reason });
        }
        if (outcome.kind === "capability_mismatch") {
          return respondError(c, outcome.kind, { provider: outcome.provider });
        }
        return respondError(c, outcome.kind);
      },
      RATE_LIMITS.WRITE_LOW,
    ),
);

app.get(
  "/portal/me/composite/:parentDeploymentId/targets/:targetDeploymentId/cli-credentials",
  (c) =>
    withBearerAuth(
      c,
      "composite-cli-credentials",
      async (token) => {
        const params = parseParams(c, CompositeTargetAccessParamSchema);
        if (!params.ok) return params.response;
        // Issue #2283: composite parent が locked なら CLI credentials も発行しない。
        const prerequisite = await getJobPrerequisiteBlock(
          shared,
          token,
          params.data.parentDeploymentId,
        );
        if (prerequisite) return respondPrerequisiteBlock(c, prerequisite);
        const outcome = await bridgeCompositeCliCredentials(shared, compositeAwsAccessDeps, {
          teamLoginKey: token,
          parentDeploymentId: params.data.parentDeploymentId,
          targetDeploymentId: params.data.targetDeploymentId,
        });
        if (outcome.kind === "ok")
          return c.json({ credentials: outcome.credentials }, StatusCodes.OK);
        if (outcome.kind === "assume_role_failed") {
          return respondError(c, outcome.kind, { stage: outcome.stage, reason: outcome.reason });
        }
        if (outcome.kind === "capability_mismatch") {
          return respondError(c, outcome.kind, { provider: outcome.provider });
        }
        return respondError(c, outcome.kind);
      },
      RATE_LIMITS.WRITE_LOW,
    ),
);

// Issue #767: notifications は frontend polling が 5s 間隔 → READ_HIGH (= 2 RPS sustained / 60 burst)。
app.get("/portal/me/notifications", (c) =>
  withBearerAuth(
    c,
    "notifications",
    async (token) => {
      const q = parseQuery(c, NotificationsQuerySchema);
      if (!q.ok) return q.response;
      // schema は数値変換 + finite 判定までを保証。 整数 / 範囲は service 側
      // (`listNotifications` の `Number.isInteger` + max cap) で final reject。
      const limit = q.data.limit === undefined ? NOTIFICATIONS_DEFAULT_LIMIT : q.data.limit;
      const outcome = await listNotifications(shared, token, limit);
      if (outcome.kind === "ok") return c.json(outcome.response, StatusCodes.OK);
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.READ_HIGH,
  ),
);

// Inter-team event dispatch primitive (= platform は dispatch だけ、 semantics は問題側 plugin)。
// 詳細は cast-event.ts の JSDoc を参照。
app.post("/portal/me/cast-event", (c) =>
  withBearerAuth(
    c,
    "cast-event",
    async (token) => {
      const parsed = await parseJsonBody(c, CastEventBodySchema);
      if (!parsed.ok) return parsed.response;
      const outcome = await castEvent(shared, token, {
        targetJobId: parsed.data.targetJobId,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
      });
      if (outcome.kind === "ok") {
        return c.json({ eventId: outcome.eventId, occurredAt: outcome.occurredAt }, StatusCodes.OK);
      }
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

app.get("/portal/me/event-inbox", (c) =>
  withBearerAuth(
    c,
    "event-inbox",
    async (token) => {
      const q = parseQuery(c, EventInboxQuerySchema);
      if (!q.ok) return q.response;
      // 既定は INBOX_SINCE_MS_MAX (= 24h 分まで) を遡る。 frontend が空で叩いても reasonable。
      const sinceMs =
        q.data.sinceMs === undefined
          ? Math.max(Date.now() - INBOX_SINCE_MS_MAX, 0)
          : q.data.sinceMs;
      const outcome = await readInbox(shared, token, q.data.jobId, sinceMs);
      if (outcome.kind === "ok") return c.json({ events: outcome.events }, StatusCodes.OK);
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.READ_HIGH,
  ),
);

app.get("/portal/me/battle-attacks", (c) =>
  withBearerAuth(c, "battle-attacks", async (token) => {
    const q = parseQuery(c, BattleAttacksQuerySchema);
    if (!q.ok) return q.response;
    const sinceMin =
      q.data.sinceMin === undefined ? BATTLE_ATTACKS_SINCE_MIN_DEFAULT : q.data.sinceMin;
    const outcome = await listBattleAttacks(shared, token, q.data.jobId, sinceMin);
    if (outcome.kind === "ok") return c.json(outcome.response, StatusCodes.OK);
    return respondError(c, outcome.kind);
  }),
);

app.get("/portal/me/deploy-logs", (c) =>
  withBearerAuth(
    c,
    "deploy-logs",
    async (token) => {
      const q = parseQuery(c, DeployLogsQuerySchema);
      if (!q.ok) return q.response;

      // 旧 parseDeployLogLimit は 1〜100 / 整数を service 側で reject する。
      // schema は string optional のみ要求、 細かい range は parseDeployLogLimit に委譲。
      const limit = parseDeployLogLimit(q.data.limit);
      if (limit === null) return respondError(c, "invalid_limit");

      // Issue #2283: CodeBuild log は CFn Outputs (接続情報) を echo するため、 locked
      // challenge の log は返さない (= stackOutputs 空化の bypass 防止)。
      const prerequisite = await getJobPrerequisiteBlock(shared, token, q.data.jobId);
      if (prerequisite) return respondPrerequisiteBlock(c, prerequisite);

      const outcome = await getParticipantDeployLogs(shared, defaultDeployLogDeps, token, {
        jobId: q.data.jobId,
        nextToken: q.data.nextToken,
        limit,
      });
      if (outcome.kind === "ok") return c.json(outcome.response, StatusCodes.OK);
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.READ_HIGH,
  ),
);

app.get("/portal/leaderboard", (c) =>
  withBearerAuth(c, "leaderboard", async (token) => {
    const outcome = await getLeaderboard(shared, token);
    if (outcome.kind === "ok") return c.json(outcome.response, StatusCodes.OK);
    return respondError(c, outcome.kind);
  }),
);

// Issue #1038 P1 #6: 全チームの累計スコア推移 (= ScoreTimelineChart multi-series 用)。
// `/portal/leaderboard` と同じ scope (= 同 event 内の全 team) で event timeline を返す。
app.get("/portal/leaderboard/score-events", (c) =>
  withBearerAuth(c, "leaderboard-score-events", async (token) => {
    const outcome = await getLeaderboardScoreEvents(shared, token);
    if (outcome.kind === "ok") return c.json(outcome.response, StatusCodes.OK);
    return respondError(c, outcome.kind);
  }),
);

// Issue #767: write 系は WRITE_LOW (= 10 burst / 0.2 RPS sustained = 12 RPM) で絞る。
app.patch("/portal/me", (c) =>
  withBearerAuth(
    c,
    "update",
    async (token) => {
      const parsed = await parseJsonBody(c, PatchMeBodySchema);
      if (!parsed.ok) return parsed.response;
      // 文字種制約 (TEAM_NAME_RE) は update.ts 側で final validate (1 source of truth)。
      const outcome = await setDisplayTeamName(shared, token, parsed.data.teamName);
      if (outcome.kind === "ok") return c.json(outcome.view, StatusCodes.OK);
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

// Issue #870: submit-flag は brute force の標的になりうるため WRITE_VERY_LOW で更に絞る
// (= 3 burst / 6 RPM = 1 attempt / 10s)。 旧 WRITE_LOW (= 12 RPM) 適用時は 1 team / day で
// 17,000 attempts 可能だった。 hint reveal / teamName 編集など他の write は WRITE_LOW のまま。
app.post("/portal/me/submit-flag", (c) =>
  withBearerAuth(
    c,
    "submitFlag",
    (token) => handleSubmitFlag(c, token),
    RATE_LIMITS.WRITE_VERY_LOW,
  ),
);

// Issue #742 Phase 3: progressive hint reveal route。 idempotent (= 同 hintId 重複 reveal は
// no-op、 既存 record の content + score を返す)。 rate limit は WRITE_LOW (= 10 burst /
// 12 RPM、 hint をブルートフォースで全部 reveal させない壁)。
app.post("/portal/me/problems/:problemId/hints/:hintId/reveal", (c) =>
  withBearerAuth(c, "reveal-hint", (token) => handleHintReveal(c, token), RATE_LIMITS.WRITE_LOW),
);

async function handleSubmitFlag(c: Context, token: string): Promise<Response> {
  const parsed = await parseJsonBody(c, SubmitFlagBodySchema);
  if (!parsed.ok) return parsed.response;
  const outcome = await submitFlag(
    shared,
    shared.problemsScoring,
    token,
    parsed.data.problemId,
    parsed.data.flag,
    parsed.data.flagId,
  );
  return respondSubmitFlagOutcome(c, outcome);
}

async function handleHintReveal(c: Context, token: string): Promise<Response> {
  const params = parseParams(c, ProblemHintParamSchema);
  if (!params.ok) return params.response;
  const outcome = await revealHint(
    shared,
    shared.problemsScoring,
    token,
    params.data.problemId,
    params.data.hintId,
  );
  return respondHintRevealOutcome(c, outcome);
}

function respondSubmitFlagOutcome(
  c: Context,
  outcome: Awaited<ReturnType<typeof submitFlag>>,
): Response {
  if (outcome.kind === "scoring_not_started") {
    return respondError(c, "scoring_not_started", { startsAt: outcome.startsAt });
  }
  if (outcome.kind === "scoring_ended") {
    return respondError(c, "scoring_ended", { endsAt: outcome.endsAt });
  }
  if (outcome.kind === "challenge_prerequisite_not_met") {
    // Issue #2283: locked challenge への提出。
    return respondPrerequisiteBlock(c, outcome);
  }
  if (
    outcome.kind === "unauthorized" ||
    outcome.kind === "not_flag_problem" ||
    // Issue #1796: multi-flag で flagId 不正 / 未指定。 unknown_hint と同じ NOT_FOUND family。
    outcome.kind === "unknown_flag" ||
    outcome.kind === "no_outputs" ||
    outcome.kind === "scoring_locked"
  ) {
    return respondError(c, outcome.kind);
  }
  return c.json(outcome, StatusCodes.OK);
}

function respondHintRevealOutcome(
  c: Context,
  outcome: Awaited<ReturnType<typeof revealHint>>,
): Response {
  if (outcome.kind === "scoring_not_started") {
    return respondError(c, "scoring_not_started", { startsAt: outcome.startsAt });
  }
  if (outcome.kind === "scoring_ended") {
    return respondError(c, "scoring_ended", { endsAt: outcome.endsAt });
  }
  if (outcome.kind === "hint_out_of_order") {
    // Issue #1315: UI が 「Hint N-1 を先に reveal」 文言を組み立てるため、 missingHintId を
    // body に含めて返す (= scoring_not_started + startsAt と同じ pattern)。
    return respondError(c, "hint_out_of_order", { missingHintId: outcome.missingHintId });
  }
  if (outcome.kind === "challenge_prerequisite_not_met") {
    // Issue #2283: locked challenge の hint 開封。
    return respondPrerequisiteBlock(c, outcome);
  }
  if (
    outcome.kind === "unauthorized" ||
    outcome.kind === "not_flag_problem" ||
    outcome.kind === "unknown_hint" ||
    outcome.kind === "scoring_locked"
  ) {
    return respondError(c, outcome.kind);
  }
  // ok / already_revealed どちらも 200 で content + score を返す (= idempotent UX)。
  return c.json(outcome, StatusCodes.OK);
}

// Endpoint registry (override) routes — 競技者が自 team の slot URL を
// 再ホスト先 (Lambda / ECS / App Runner 等) に切り替えるための CRUD。auth は teamLoginKey
// bearer (= submit-flag と同じ scope)。
//
//   GET    /portal/me/problems/:problemId/endpoints
//   POST   /portal/me/problems/:problemId/endpoints/:slot  { url }
//   DELETE /portal/me/problems/:problemId/endpoints/:slot
app.get("/portal/me/problems/:problemId/endpoints", (c) =>
  withBearerAuth(c, "list-endpoints", async (token) => {
    const params = parseParams(c, ProblemIdParamSchema);
    if (!params.ok) return params.response;
    const outcome = await listProblemEndpoints(shared, token, params.data.problemId);
    if (outcome.kind === "ok") {
      return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
    }
    if (outcome.kind === "challenge_prerequisite_not_met") {
      // Issue #2283: locked challenge の endpoint 一覧 (接続 URL) は返さない。
      return respondPrerequisiteBlock(c, outcome);
    }
    return respondError(c, outcome.kind);
  }),
);

app.post("/portal/me/problems/:problemId/endpoints/:slot", (c) =>
  withBearerAuth(
    c,
    "put-endpoint",
    async (token) => {
      const params = parseParams(c, ProblemSlotParamSchema);
      if (!params.ok) return params.response;
      const body = await parseJsonBody(c, UpsertEndpointBodySchema);
      if (!body.ok) return body.response;
      const outcome = await upsertProblemEndpointOverride(
        shared,
        token,
        params.data.problemId,
        params.data.slot,
        body.data.url,
        new Date().toISOString(),
      );
      if (outcome.kind === "ok") {
        return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
      }
      if (outcome.kind === "challenge_prerequisite_not_met") {
        // Issue #2283: locked challenge への endpoint 登録 / 更新。
        return respondPrerequisiteBlock(c, outcome);
      }
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

app.delete("/portal/me/problems/:problemId/endpoints/:slot", (c) =>
  withBearerAuth(
    c,
    "delete-endpoint",
    async (token) => {
      const params = parseParams(c, ProblemSlotParamSchema);
      if (!params.ok) return params.response;
      const outcome = await deleteProblemEndpointOverride(
        shared,
        token,
        params.data.problemId,
        params.data.slot,
      );
      if (outcome.kind === "ok") {
        return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
      }
      if (outcome.kind === "challenge_prerequisite_not_met") {
        // Issue #2283: locked challenge の endpoint override 解除。
        return respondPrerequisiteBlock(c, outcome);
      }
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
