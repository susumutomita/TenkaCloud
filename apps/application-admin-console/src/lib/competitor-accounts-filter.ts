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
