import { StatusCodes } from "http-status-codes";

import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalNetworkError,
  PortalScoringGateError,
  PortalValidationError,
} from "./errors";
import type { AssumeRoleStage } from "./types";

/**
 * Portal API 共通 fetch 層。 全 endpoint で共有する error mapping (401 → PortalAuthError /
 * 500 → PortalNetworkError) と、 opt-in な variant (400 / 404 / 409 / assume_role_failed) を
 * 1 箇所に集約する。 endpoint 個別ファイル (= team.ts / scoring.ts etc.) は
 * `portalFetch(...)` を呼ぶだけで shape を組み立てる責務を負わない。
 */

export interface PortalFetchOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** 400 を `PortalValidationError(error)` に変換する (応答 body の `error` フィールドを採用)。 */
  readonly throwOn400?: boolean;
  /** 409 (conflict、 例: slot_not_overridable) を validation error として扱う。 */
  readonly throwOn409?: boolean;
  /** 404 を `undefined` として返す (= "存在しない" を許容するエンドポイント)。 */
  readonly returnUndefinedOn404?: boolean;
  /**
   * Issue #1197: 500 + error="assume_role_failed" を `PortalAssumeRoleError` に変換する。
   * SSO / CLI credentials のように 「どちらの AssumeRole 段で落ちたか」 を UI が必要と
   * する endpoint で opt-in する。 他の 500 は従来通り `PortalNetworkError`。
   */
  readonly throwOnAssumeRoleFailed?: boolean;
}

interface PortalErrorBody {
  readonly error?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  /** Issue #1197: assume_role_failed の付加情報。 stage = どちらの段で落ちたか、 reason = STS error name。 */
  readonly stage?: string;
  readonly reason?: string;
  /** Issue #1315: hint_out_of_order の 「次に開けるべき直前 hint」 id。 */
  readonly missingHintId?: string;
  /** Issue #2283: challenge_prerequisite_not_met の 「先に完了すべき Gate 問題」 id。 */
  readonly gateProblemId?: string;
}

function isAssumeRoleStage(value: unknown): value is AssumeRoleStage {
  return value === "competitor" || value === "participant_viewer";
}

function buildPortalUrl(apiBaseUrl: string, path: string): URL {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(path, base);
}

function applyPortalQuery(url: URL, query?: Readonly<Record<string, string>>): void {
  if (!query) return;
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
}

function buildPortalFetchInit(teamLoginKey: string, options: PortalFetchOptions): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${teamLoginKey}` };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  return {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    // Issue #2190: without this, the browser HTTP cache can serve a stale GET
    // response for a manual refetch (refresh button / post-publish reload),
    // even though a full page reload would revalidate via max-age=0. Portal
    // state (hints/scoring) must always reflect the server's current state.
    cache: "no-store",
  };
}

async function readPortalErrorBody(res: Response): Promise<PortalErrorBody> {
  return (await res.json().catch(() => ({}))) as PortalErrorBody;
}

function isScoringGateError(
  error: string | undefined,
): error is "scoring_not_started" | "scoring_ended" | "scoring_locked" {
  return error === "scoring_not_started" || error === "scoring_ended" || error === "scoring_locked";
}

async function throwConflictError(res: Response): Promise<never> {
  const body = await readPortalErrorBody(res);
  // Issue #1006: scoring gate 系の 409 は startsAt / endsAt を持つ専用 error にする。
  if (isScoringGateError(body.error)) {
    throw new PortalScoringGateError(body.error, body.startsAt, body.endsAt);
  }
  // Issue #1315: hint_out_of_order は body.missingHintId を details に詰めて UI が
  // 「Hint N-1 を先に reveal してください」 文言を組み立てられるようにする。
  if (body.error === "hint_out_of_order") {
    throw new PortalValidationError("hint_out_of_order", {
      missingHintId: body.missingHintId,
    });
  }
  // Issue #2283: Progression Gate。 locked 問題への mutation (flag 提出 / endpoint 登録 /
  // hint reveal) は 409 challenge_prerequisite_not_met で拒否される。 gateProblemId を
  // details に詰めて UI が 「どの Gate 問題を先に完了すべきか」 を案内できるようにする。
  // (通常は UI 側の lock 表示で到達しない — backend guard の defense-in-depth。)
  if (body.error === "challenge_prerequisite_not_met") {
    throw new PortalValidationError("challenge_prerequisite_not_met", {
      gateProblemId: body.gateProblemId,
    });
  }
  throw new PortalValidationError(body.error ?? "conflict");
}

/**
 * Issue #1197: 500 + error="assume_role_failed" を `PortalAssumeRoleError` に変換する。
 * 他の 500 は呼び元の throwOnAssumeRoleFailed が opt-in なときだけ通り、 fallback で
 * `PortalNetworkError` に倒す (= 後続の `if (!res.ok)` が拾う想定)。
 */
async function throwAssumeRoleFailedError(res: Response): Promise<never> {
  const body = await readPortalErrorBody(res);
  if (body.error === "assume_role_failed") {
    const stage = isAssumeRoleStage(body.stage) ? body.stage : "competitor";
    throw new PortalAssumeRoleError(stage, body.reason ?? "Unknown");
  }
  throw new PortalNetworkError(res.status, body.error ?? "internal_error");
}

async function throwPortalErrorResponse(res: Response, options: PortalFetchOptions): Promise<void> {
  if (res.status === StatusCodes.UNAUTHORIZED) throw new PortalAuthError();
  if (res.status === StatusCodes.BAD_REQUEST && options.throwOn400) {
    const body = await readPortalErrorBody(res);
    throw new PortalValidationError(body.error ?? "invalid_request");
  }
  if (res.status === StatusCodes.CONFLICT && options.throwOn409) {
    await throwConflictError(res);
  }
  // [#3008] 422 は「この機材ではこの問題の結果に意味が無いので起動しない」。 generic な
  // PortalNetworkError(422, 生 text) にすると、 参加者には JSON 断片が出るだけで、
  // 何が足りないのか (architecture か CPU flag か) が読めない。 details を保って UI が
  // locale 付きの本文を出せるようにする。
  if (res.status === StatusCodes.UNPROCESSABLE_ENTITY) {
    const body = await readPortalErrorBody(res);
    throw new PortalValidationError(body.error ?? "unprocessable", { ...body });
  }
  if (res.status === StatusCodes.INTERNAL_SERVER_ERROR && options.throwOnAssumeRoleFailed) {
    await throwAssumeRoleFailedError(res);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PortalNetworkError(res.status, body);
  }
}

/**
 * Portal API 共通 fetch。401→PortalAuthError / !ok→PortalNetworkError は全 endpoint
 * 共通なので 1 箇所に集約。400 (validation) と 404 (no-content) は opt-in。
 */
export async function portalFetch<T>(
  apiBaseUrl: string,
  path: string,
  teamLoginKey: string,
  options: PortalFetchOptions = {},
): Promise<T | undefined> {
  const url = buildPortalUrl(apiBaseUrl, path);
  applyPortalQuery(url, options.query);
  const res = await fetch(url, buildPortalFetchInit(teamLoginKey, options));
  if (res.status === StatusCodes.NOT_FOUND && options.returnUndefinedOn404) return undefined;
  await throwPortalErrorResponse(res, options);
  return (await res.json()) as T;
}
