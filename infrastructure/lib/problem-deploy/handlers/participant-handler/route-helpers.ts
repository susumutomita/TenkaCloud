import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  participantRateLimiter,
  RATE_LIMITS,
  type RateLimitConfig,
} from "../shared/rate-limiter.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { extractBearerToken } from "./auth.js";

/**
 * 業務ロジックが返す失敗 outcome の kind 一覧と HTTP status の対応表。
 * route handler が個別に if-cascade で書いていた mapping を 1 箇所に集約する
 * (新 outcome 追加時の触る場所を減らす)。
 */
const ERROR_STATUS = {
  unauthorized: StatusCodes.UNAUTHORIZED,
  invalid_jobid: StatusCodes.BAD_REQUEST,
  invalid_sincemin: StatusCodes.BAD_REQUEST,
  invalid_limit: StatusCodes.BAD_REQUEST,
  invalid_team_name: StatusCodes.BAD_REQUEST,
  invalid_problem_id: StatusCodes.BAD_REQUEST,
  invalid_flag: StatusCodes.BAD_REQUEST,
  invalid_body: StatusCodes.BAD_REQUEST,
  missing_jobid: StatusCodes.BAD_REQUEST,
  not_ready: StatusCodes.BAD_REQUEST,
  not_flag_problem: StatusCodes.BAD_REQUEST,
  invalid_hint_id: StatusCodes.BAD_REQUEST,
  unknown_hint: StatusCodes.NOT_FOUND,
  // Issue #1796: multi-flag で flagId が未指定 / metadata の flags[] に無い id。 unknown_hint と
  // 同じ NOT_FOUND family (= 指定された sub-flag が存在しない)。
  unknown_flag: StatusCodes.NOT_FOUND,
  // Issue #1315: progressive hint の順序違反 (= Hint 1 未 reveal で Hint 2 を request)。
  // 409 (= 状態的に受け付けない、 scoring_locked と同じ conflict 系) + body に missingHintId。
  hint_out_of_order: StatusCodes.CONFLICT,
  no_outputs: StatusCodes.BAD_REQUEST,
  no_event: StatusCodes.NOT_FOUND,
  not_found: StatusCodes.NOT_FOUND,
  scoring_locked: StatusCodes.CONFLICT,
  // Issue #13 / scoring gate: 競技開始前 / 終了後の提出。 409 (= 状態的に受け付けない)。
  scoring_not_started: StatusCodes.CONFLICT,
  scoring_ended: StatusCodes.CONFLICT,
  // Issue #2283: Progression Gate 未完了の locked challenge への競技操作。 409 (= 状態系、
  // Gate challenge 完了で解消する)。 body に gateProblemId を含めて UI が誘導文言を出す。
  challenge_prerequisite_not_met: StatusCodes.CONFLICT,
  misconfigured: StatusCodes.INTERNAL_SERVER_ERROR,
  // Issue #705: SSO の "misconfigured" を細分化 (= 原因切り分け可能に)。
  assume_role_failed: StatusCodes.INTERNAL_SERVER_ERROR,
  federation_endpoint_failed: StatusCodes.INTERNAL_SERVER_ERROR,
  federation_token_malformed: StatusCodes.INTERNAL_SERVER_ERROR,
  internal_error: StatusCodes.INTERNAL_SERVER_ERROR,
  // endpoint registry
  no_endpoints: StatusCodes.NOT_FOUND,
  unknown_slot: StatusCodes.BAD_REQUEST,
  slot_not_overridable: StatusCodes.CONFLICT,
  invalid_url: StatusCodes.BAD_REQUEST,
  invalid_slot: StatusCodes.BAD_REQUEST,
  // [Composite Runtime / Issue #2077] AWS access bridge: the resolved composite
  // target is not an AWS target (gcp / azure / sakura / unsupported), so the
  // existing AWS Console / CLI path does not apply. 409 — a state-based mismatch,
  // not a malformed request — and STS was never invoked.
  capability_mismatch: StatusCodes.CONFLICT,
  // Inter-team event dispatch primitive (cast-event.ts)
  invalid_kind: StatusCodes.BAD_REQUEST,
  invalid_payload: StatusCodes.BAD_REQUEST,
  invalid_since_ms: StatusCodes.BAD_REQUEST,
  target_not_found: StatusCodes.NOT_FOUND,
  cross_event_forbidden: StatusCodes.CONFLICT,
} as const;

export type ErrorKind = keyof typeof ERROR_STATUS;

export function respondError(
  c: Context,
  kind: ErrorKind,
  extras?: Readonly<Record<string, unknown>>,
) {
  // Issue #1006: scoring_not_started / scoring_ended では startsAt / endsAt を body に含めて
  // UI が 「競技開始まで N 分」 等の親切な文言を出せるようにする。 旧来は { error: kind } のみで
  // ユーザーが 「いつ始まるのか」 分からず迷子になっていた。
  if (extras && Object.keys(extras).length > 0) {
    return c.json({ error: kind, ...extras }, ERROR_STATUS[kind]);
  }
  return c.json({ error: kind }, ERROR_STATUS[kind]);
}

/**
 * Bearer token 必須 route の共通テンプレ。 token 抽出 + per-team rate limit + try/catch + 500 ログ。
 * handler 側は token を受け取って outcome / Response を返すだけ。
 *
 * Issue #767: rateLimit を指定すると、 `(teamLoginKey, routeName)` 単位で token bucket を
 * 引いて DoS / 暴走耐性を上げる。 デフォルトは READ_MID (= 60 burst / 1 RPS sustained)。
 * 書き込み系 (submit-flag / endpoint override / patch /me) は WRITE_LOW を渡して厳しく絞る。
 * 拒否時は 429 + Retry-After header を返し、 frontend は normal polling 文脈なら再試行する。
 */
export async function withBearerAuth(
  c: Context,
  routeName: string,
  handler: (token: string) => Promise<Response>,
  rateLimit: RateLimitConfig = RATE_LIMITS.READ_MID,
): Promise<Response> {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return respondError(c, "unauthorized");

  const outcome = participantRateLimiter.take(`${token}|${routeName}`, rateLimit);
  if (!outcome.allowed) {
    logDeployTrace("portal.rate_limit.rejected", {
      routeName,
      retryAfterSec: outcome.retryAfterSec,
      capacity: rateLimit.capacity,
      refillPerSec: rateLimit.refillPerSec,
    });
    c.header("Retry-After", String(outcome.retryAfterSec));
    return c.json(
      { error: "rate_limited", retryAfterSec: outcome.retryAfterSec },
      StatusCodes.TOO_MANY_REQUESTS,
    );
  }

  try {
    return await handler(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[portal] ${routeName} failed`, { message });
    return respondError(c, "internal_error");
  }
}

/**
 * Issue #1242 / #2211: route 入口の JSON body / query / param 検証は
 * `shared/http-parse.ts` に集約された共通ヘルパーを使う。 出力形状は不変
 * (JSON parse 失敗 → `invalid_body` (400) / schema 不一致 → `validation_failed`
 * + issues (400))。 back-compat のためここから re-export する。
 */
export { parseJsonBody, parseParams, parseQuery } from "../shared/http-parse.js";
