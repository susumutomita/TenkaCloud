/**
 * Issue #1349: portal の error 表示を競技者向けに翻訳する純関数。
 *
 * `PortalAuthError` / `PortalValidationError` 等の internal error class を、
 * 競技 (event-day) 文脈で意味のあるメッセージに変える:
 *
 *  - 401 (PortalAuthError) → 「ログイン期限切れ。 organizer から再配布された login key で
 *    再ログインしてください」
 *  - 400 (PortalValidationError) で `invalid_flag` → 「flag が違います (残 N 回 試行可)」
 *  - その他 → 既存 message (= 生 HTTP status は出さない)
 *
 * 設計判断:
 *  - i18n key を返さない (= caller 側で t() を呼ばずに直接 message を表示できるように
 *    locale-aware な文字列を組み立てて return する)。 caller が t を渡す signature。
 *  - portal-client を直接 import しない (= sub-class identity 依存を避けて pure に保つ)。
 *    caller が name で判定して context を渡す。
 */

import { PortalAuthError, PortalNetworkError, PortalValidationError } from "../api/portal-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface FriendlyErrorContext {
  /** flag 提出 context のとき、残試行回数 (= 5 - wrongCount)。 */
  readonly flagRemainingAttempts?: number;
  /** facilitator support 用 deployment id / correlation id (出る画面のみ)。 */
  readonly correlationId?: string;
}

/**
 * 競技者向けに整形された error message を返す。
 *
 * raw HTTP status code / stack trace は絶対に出さない (= 「ログイン期限切れ」 等を
 * 競技者に伝えるのが目的)。
 */
export function friendlyErrorMessage(
  err: unknown,
  t: Translate,
  ctx: FriendlyErrorContext = {},
): string {
  if (err instanceof PortalAuthError) {
    return t("friendly_error.auth_expired");
  }
  if (err instanceof PortalValidationError) {
    if (err.errorCode === "invalid_flag" && ctx.flagRemainingAttempts !== undefined) {
      return t("friendly_error.invalid_flag_with_remaining", {
        remaining: ctx.flagRemainingAttempts,
      });
    }
    if (err.errorCode === "invalid_flag") {
      return t("friendly_error.invalid_flag");
    }
    if (err.errorCode === "invalid_url") {
      return t("friendly_error.invalid_url");
    }
    // Issue #2283: Progression Gate。 locked 問題への mutation は backend が 409
    // challenge_prerequisite_not_met で拒否する。 UI の lock 表示で通常は到達しないが、
    // 届いたら 「先に Gate 問題を完了して」 と案内する (defense-in-depth)。
    if (err.errorCode === "challenge_prerequisite_not_met") {
      return t("friendly_error.prerequisite_locked");
    }
    return t("friendly_error.validation_generic", { code: err.errorCode });
  }
  if (err instanceof PortalNetworkError) {
    // PortalNetworkError は status code を field で保持しているが、 競技者に
    // 「502 Bad Gateway」 と見せても何も助けにならない。 facilitator に伝える
    // ための correlationId だけを出す。
    if (ctx.correlationId) {
      return t("friendly_error.network_with_correlation", { correlationId: ctx.correlationId });
    }
    return t("friendly_error.network");
  }
  if (err instanceof Error) {
    return err.message;
  }
  return t("friendly_error.unknown");
}
