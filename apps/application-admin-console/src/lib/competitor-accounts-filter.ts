import { StatusCodes } from "http-status-codes";
import { ApiError } from "../api/client";
import type { CompetitorAccountSummary } from "../api/competitor-accounts-client";

/**
 * Issue #671: EventCreate Wizard の Team AWS Account dropdown に流す verified-only filter。
 *
 * - `verified === true` ではなく `Boolean(verified)` で truthy 比較する。
 *   backend が万一 string `"true"` で返したり、 ABI の不一致で number 1 が来ても弾かない。
 * - 副作用なし pure function。 useMemo の deps に使いやすく test も容易にするため抽出。
 */
export function filterVerifiedAccounts(
  accounts: readonly CompetitorAccountSummary[] | null,
): readonly CompetitorAccountSummary[] {
  if (!accounts) return [];
  return accounts.filter((a) => Boolean(a.verified));
}

/**
 * Issue #815: EventCreate / CompetitorAccounts ページの `listCompetitorAccounts`
 * 失敗時に operator が次の一手を判断しやすい文言を返す。
 *
 * - 401 (= JWT claim 不在 / token 失効) → 「再ログインしてください」 (= PR-#844 で
 *   `unknown-tenant` silent fallback が消えたので、 claim 欠落 token は **必ず 401**)
 * - その他 → raw message を出す (= 開発時のデバッグに必要、 backend message 抑制は別 Issue)
 */
export function formatCompetitorAccountsLoadError(err: unknown): string {
  if (err instanceof ApiError && err.status === StatusCodes.UNAUTHORIZED) {
    return "セッションが切れているか、 JWT に tenantId claim がありません。 サインアウトして再ログインしてください (= 再ログイン後も再現するときは System Admin に連絡)。";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
