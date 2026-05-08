import type { Context } from "hono";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
} from "../shared/http-status.js";
import { extractBearerToken } from "./auth.js";

/**
 * 業務ロジックが返す失敗 outcome の kind 一覧と HTTP status の対応表。
 * route handler が個別に if-cascade で書いていた mapping を 1 箇所に集約する
 * (新 outcome 追加時の触る場所を減らす)。
 */
const ERROR_STATUS = {
  unauthorized: HTTP_UNAUTHORIZED,
  invalid_jobid: HTTP_BAD_REQUEST,
  invalid_team_name: HTTP_BAD_REQUEST,
  invalid_problem_id: HTTP_BAD_REQUEST,
  invalid_flag: HTTP_BAD_REQUEST,
  invalid_body: HTTP_BAD_REQUEST,
  missing_jobid: HTTP_BAD_REQUEST,
  not_ready: HTTP_BAD_REQUEST,
  not_flag_problem: HTTP_BAD_REQUEST,
  no_outputs: HTTP_BAD_REQUEST,
  no_event: HTTP_NOT_FOUND,
  misconfigured: HTTP_INTERNAL_ERROR,
  internal_error: HTTP_INTERNAL_ERROR,
} as const;

export type ErrorKind = keyof typeof ERROR_STATUS;

export function respondError(c: Context, kind: ErrorKind) {
  return c.json({ error: kind }, ERROR_STATUS[kind]);
}

/**
 * Bearer token 必須 route の共通テンプレ。token 抽出 + try/catch + 500 ログ。
 * handler 側は token を受け取って outcome / Response を返すだけ。
 */
export async function withBearerAuth(
  c: Context,
  routeName: string,
  handler: (token: string) => Promise<Response>,
): Promise<Response> {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return respondError(c, "unauthorized");
  try {
    return await handler(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[portal] ${routeName} failed`, { message });
    return respondError(c, "internal_error");
  }
}
