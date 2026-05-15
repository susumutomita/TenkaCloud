import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
} from "../shared/http-status.js";
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
  unauthorized: HTTP_UNAUTHORIZED,
  invalid_jobid: HTTP_BAD_REQUEST,
  invalid_sincemin: HTTP_BAD_REQUEST,
  invalid_limit: HTTP_BAD_REQUEST,
  invalid_team_name: HTTP_BAD_REQUEST,
  invalid_problem_id: HTTP_BAD_REQUEST,
  invalid_flag: HTTP_BAD_REQUEST,
  invalid_body: HTTP_BAD_REQUEST,
  missing_jobid: HTTP_BAD_REQUEST,
  not_ready: HTTP_BAD_REQUEST,
  not_flag_problem: HTTP_BAD_REQUEST,
  invalid_hint_id: HTTP_BAD_REQUEST,
  unknown_hint: HTTP_NOT_FOUND,
  no_outputs: HTTP_BAD_REQUEST,
  no_event: HTTP_NOT_FOUND,
  not_found: HTTP_NOT_FOUND,
  scoring_locked: HTTP_CONFLICT,
  misconfigured: HTTP_INTERNAL_ERROR,
  // Issue #705: SSO の "misconfigured" を細分化 (= 原因切り分け可能に)。
  assume_role_failed: HTTP_INTERNAL_ERROR,
  federation_endpoint_failed: HTTP_INTERNAL_ERROR,
  federation_token_malformed: HTTP_INTERNAL_ERROR,
  internal_error: HTTP_INTERNAL_ERROR,
  // ADR-012 Phase 3.A: endpoint registry
  no_endpoints: HTTP_NOT_FOUND,
  unknown_slot: HTTP_BAD_REQUEST,
  slot_not_overridable: HTTP_CONFLICT,
  invalid_url: HTTP_BAD_REQUEST,
  invalid_slot: HTTP_BAD_REQUEST,
} as const;

export type ErrorKind = keyof typeof ERROR_STATUS;

export function respondError(c: Context, kind: ErrorKind) {
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
