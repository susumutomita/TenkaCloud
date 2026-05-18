import { Hono } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import {
  deleteProblemEndpointOverride,
  listProblemEndpoints,
  upsertProblemEndpointOverride,
} from "../problem-endpoints-handler/endpoints.js";
import { PROBLEM_ID_RE } from "../shared/constants.js";
import { HTTP_OK } from "../shared/http-status.js";
import { RATE_LIMITS } from "../shared/rate-limiter.js";
import { BATTLE_ATTACKS_SINCE_MIN_DEFAULT, listBattleAttacks } from "./battle-attacks.js";
import { getLeaderboard } from "./leaderboard.js";
import { getLeaderboardScoreEvents } from "./leaderboard-score-events.js";
import { lookupTeamByLoginKey } from "./lookup.js";
import { listNotifications, NOTIFICATIONS_DEFAULT_LIMIT } from "./notifications.js";
import { revealHint } from "./reveal-hint.js";
import { respondError, withBearerAuth } from "./route-helpers.js";
import { listScoreEvents } from "./score-events.js";
import { buildParticipantSharedResources } from "./shared.js";
import { getConsoleSigninUrl } from "./sso.js";
import { submitFlag } from "./submit-flag.js";
import { setDisplayTeamName } from "./update.js";

/** ADR-012 Phase 3.A: slot 名は kebab-case (= metadata.endpoints[].slot pattern と同じ)。 */
const SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Participant Portal backend Lambda の Hono app (Phase 2c で team scope)。routes:
 *   GET   /portal/healthz
 *   GET   /portal/leaderboard           — event scope の team ランキング
 *   GET   /portal/me/score-events       — 自チームの加点履歴 (時系列降順)
 *   GET   /portal/me/notifications      — 自 event 宛の運営通知 (ADR-006、時系列降順)
 *   GET   /portal/me                    — Authorization: Bearer <teamLoginKey>
 *                                         → { team, problems[] }
 *   GET   /portal/me/console-signin-url — AWS Console federation login URL 発行
 *   PATCH /portal/me                    — body: { teamName: string }
 *   POST  /portal/me/submit-flag        — body: { problemId: string, flag: string }
 *
 * Function URL は `AuthType=NONE` で公開し、`teamLoginKey` 自体を bearer として
 * Lambda 内で検証する。ボイラープレート (token 抽出 / 500 ハンドリング / outcome→HTTP)
 * は `route-helpers.ts` に集約。
 */
const shared = buildParticipantSharedResources();
const app = new Hono();

app.get("/portal/healthz", (c) => c.json({ ok: true }));

app.get("/portal/me", (c) =>
  withBearerAuth(c, "lookup", async (token) => {
    const view = await lookupTeamByLoginKey(shared, token);
    if (!view) return respondError(c, "unauthorized");
    return c.json(view, HTTP_OK);
  }),
);

app.get("/portal/me/score-events", (c) =>
  withBearerAuth(c, "score-events", async (token) => {
    const outcome = await listScoreEvents(shared, token);
    if (outcome.kind === "unauthorized") return respondError(c, "unauthorized");
    return c.json(outcome.response, HTTP_OK);
  }),
);

app.get("/portal/me/console-signin-url", (c) =>
  withBearerAuth(c, "sso", async (token) => {
    const jobId = c.req.query("jobId");
    if (!jobId) return respondError(c, "missing_jobid");
    const outcome = await getConsoleSigninUrl(shared, token, jobId);
    if (outcome.kind === "ok") return c.json({ loginUrl: outcome.loginUrl }, HTTP_OK);
    return respondError(c, outcome.kind);
  }),
);

// Issue #767: notifications は frontend polling が 5s 間隔 → READ_HIGH (= 2 RPS sustained / 60 burst)。
app.get("/portal/me/notifications", (c) =>
  withBearerAuth(
    c,
    "notifications",
    async (token) => {
      const limitRaw = c.req.query("limit");
      // `Number` で strict parse — "100.5" や "10abc" は NaN/float になり listNotifications
      // 側の `Number.isInteger` で reject。`parseInt` だと truncate されて silent pass する。
      const limit = limitRaw === undefined ? NOTIFICATIONS_DEFAULT_LIMIT : Number(limitRaw);
      const outcome = await listNotifications(shared, token, limit);
      if (outcome.kind === "ok") return c.json(outcome.response, HTTP_OK);
      return respondError(c, outcome.kind);
    },
    RATE_LIMITS.READ_HIGH,
  ),
);

app.get("/portal/me/battle-attacks", (c) =>
  withBearerAuth(c, "battle-attacks", async (token) => {
    const jobId = c.req.query("jobId");
    if (!jobId) return respondError(c, "missing_jobid");
    const sinceMinRaw = c.req.query("sinceMin");
    // `Number` を使い "60.9" / "1abc" のような non-integer は NaN または float に
    // して `listBattleAttacks` 側の `Number.isInteger` で reject させる。`parseInt` は
    // truncate するので "60.9"→60 / "1abc"→1 と silently 通ってしまう。
    const sinceMin =
      sinceMinRaw === undefined ? BATTLE_ATTACKS_SINCE_MIN_DEFAULT : Number(sinceMinRaw);
    const outcome = await listBattleAttacks(shared, token, jobId, sinceMin);
    if (outcome.kind === "ok") return c.json(outcome.response, HTTP_OK);
    return respondError(c, outcome.kind);
  }),
);

app.get("/portal/leaderboard", (c) =>
  withBearerAuth(c, "leaderboard", async (token) => {
    const outcome = await getLeaderboard(shared, token);
    if (outcome.kind === "ok") return c.json(outcome.response, HTTP_OK);
    return respondError(c, outcome.kind);
  }),
);

// Issue #1038 P1 #6: 全チームの累計スコア推移 (= ScoreTimelineChart multi-series 用)。
// `/portal/leaderboard` と同じ scope (= 同 event 内の全 team) で event timeline を返す。
app.get("/portal/leaderboard/score-events", (c) =>
  withBearerAuth(c, "leaderboard-score-events", async (token) => {
    const outcome = await getLeaderboardScoreEvents(shared, token);
    if (outcome.kind === "ok") return c.json(outcome.response, HTTP_OK);
    return respondError(c, outcome.kind);
  }),
);

// Issue #767: write 系は WRITE_LOW (= 10 burst / 0.2 RPS sustained = 12 RPM) で絞る。
app.patch("/portal/me", (c) =>
  withBearerAuth(
    c,
    "update",
    async (token) => {
      const body = await c.req.json().catch(() => null);
      if (body === null) return respondError(c, "invalid_body");
      const teamName = (body as { teamName?: unknown }).teamName;
      const outcome = await setDisplayTeamName(shared, token, teamName);
      if (outcome.kind === "ok") return c.json(outcome.view, HTTP_OK);
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
    async (token) => {
      const body = await c.req.json().catch(() => null);
      if (body === null) return respondError(c, "invalid_body");
      const problemId = (body as { problemId?: unknown }).problemId;
      const flag = (body as { flag?: unknown }).flag;
      if (typeof problemId !== "string" || !PROBLEM_ID_RE.test(problemId)) {
        return respondError(c, "invalid_problem_id");
      }
      if (typeof flag !== "string" || flag.length === 0 || flag.length > 200) {
        return respondError(c, "invalid_flag");
      }
      const outcome = await submitFlag(shared, shared.problemsScoring, token, problemId, flag);
      if (outcome.kind === "unauthorized") return respondError(c, "unauthorized");
      if (outcome.kind === "not_flag_problem") return respondError(c, "not_flag_problem");
      if (outcome.kind === "no_outputs") return respondError(c, "no_outputs");
      if (outcome.kind === "scoring_locked") return respondError(c, "scoring_locked");
      // Issue #13 / #1006: scoring gate failures に startsAt / endsAt を含めて返す。
      // UI で 「競技開始まで N 分」 / 「競技は X 終了しました」 を出せるようにする。
      if (outcome.kind === "scoring_not_started") {
        return respondError(c, "scoring_not_started", { startsAt: outcome.startsAt });
      }
      if (outcome.kind === "scoring_ended") {
        return respondError(c, "scoring_ended", { endsAt: outcome.endsAt });
      }
      return c.json(outcome, HTTP_OK);
    },
    RATE_LIMITS.WRITE_VERY_LOW,
  ),
);

// Issue #742 Phase 3: progressive hint reveal route。 idempotent (= 同 hintId 重複 reveal は
// no-op、 既存 record の content + score を返す)。 rate limit は WRITE_LOW (= 10 burst /
// 12 RPM、 hint をブルートフォースで全部 reveal させない壁)。
app.post("/portal/me/problems/:problemId/hints/:hintId/reveal", (c) =>
  withBearerAuth(
    c,
    "reveal-hint",
    async (token) => {
      const problemId = c.req.param("problemId");
      if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
        return respondError(c, "invalid_problem_id");
      }
      const hintId = c.req.param("hintId");
      if (!hintId || hintId.length === 0 || hintId.length > 64) {
        return respondError(c, "invalid_hint_id");
      }
      const outcome = await revealHint(shared, shared.problemsScoring, token, problemId, hintId);
      if (outcome.kind === "unauthorized") return respondError(c, "unauthorized");
      if (outcome.kind === "not_flag_problem") return respondError(c, "not_flag_problem");
      if (outcome.kind === "unknown_hint") return respondError(c, "unknown_hint");
      // Issue #1005 / #1006: scoring gate failures with startsAt / endsAt context.
      if (outcome.kind === "scoring_not_started") {
        return respondError(c, "scoring_not_started", { startsAt: outcome.startsAt });
      }
      if (outcome.kind === "scoring_ended") {
        return respondError(c, "scoring_ended", { endsAt: outcome.endsAt });
      }
      if (outcome.kind === "scoring_locked") return respondError(c, "scoring_locked");
      // ok / already_revealed どちらも 200 で content + score を返す (= idempotent UX)。
      return c.json(outcome, HTTP_OK);
    },
    RATE_LIMITS.WRITE_LOW,
  ),
);

// ADR-012 Phase 3.A: Endpoint registry (override) routes — 競技者が自 team の slot URL を
// 再ホスト先 (Lambda / ECS / App Runner 等) に切り替えるための CRUD。auth は teamLoginKey
// bearer (= submit-flag と同じ scope)。
//
//   GET    /portal/me/problems/:problemId/endpoints
//   POST   /portal/me/problems/:problemId/endpoints/:slot  { url }
//   DELETE /portal/me/problems/:problemId/endpoints/:slot
app.get("/portal/me/problems/:problemId/endpoints", (c) =>
  withBearerAuth(c, "list-endpoints", async (token) => {
    const problemId = c.req.param("problemId");
    if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
      return respondError(c, "invalid_problem_id");
    }
    const outcome = await listProblemEndpoints(shared, token, problemId);
    if (outcome.kind === "ok") {
      return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
    }
    return respondError(c, outcome.kind);
  }),
);

app.post("/portal/me/problems/:problemId/endpoints/:slot", (c) =>
  withBearerAuth(
    c,
    "put-endpoint",
    async (token) => {
      const problemId = c.req.param("problemId");
      if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
        return respondError(c, "invalid_problem_id");
      }
      const slot = c.req.param("slot");
      if (!slot || !SLOT_NAME_RE.test(slot)) {
        return respondError(c, "invalid_slot");
      }
      const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
      if (body === null) return respondError(c, "invalid_body");
      const outcome = await upsertProblemEndpointOverride(
        shared,
        token,
        problemId,
        slot,
        body.url,
        new Date().toISOString(),
      );
      if (outcome.kind === "ok") {
        return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
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
      const problemId = c.req.param("problemId");
      if (!problemId || !PROBLEM_ID_RE.test(problemId)) {
        return respondError(c, "invalid_problem_id");
      }
      const slot = c.req.param("slot");
      if (!slot || !SLOT_NAME_RE.test(slot)) {
        return respondError(c, "invalid_slot");
      }
      const outcome = await deleteProblemEndpointOverride(shared, token, problemId, slot);
      if (outcome.kind === "ok") {
        return c.json({ endpoints: outcome.endpoints, teamId: outcome.teamId }, StatusCodes.OK);
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
