/**
 * Issue #1362 / #1446: 用途別グルーピング + 表示加工 helpers。
 *
 * Qiita 記事 (https://qiita.com/mskmiki/items/544149987475719e417b) で言う
 * 「DB 生値そのまま表示」 を防ぐための pure formatter 群。 汎用の `formatRelativeTime` は
 * #1446 で `@tenkacloud/format` に集約し re-export する (呼び出し元は不変)。 ここには
 * application-admin-console 固有の label formatter (event status / role = 別ドメイン) を残す。
 *
 *   - `formatRelativeTime(iso)`   : ISO timestamp → 「2 時間前」 (= @tenkacloud/format 由来)
 *   - `formatEventStatus(status)` : Event status enum → 日本語 / 英語のラベル (= "READY" → 「準備完了」)
 *   - `formatRole(role)`          : SBT user role enum → 日本語 / 英語ラベル
 *
 * 全て **言語切替に追従** するため引数で `lang` を受ける純粋関数。 React component 側は
 * `useT()` ではなく直接これを呼ぶ (= 引数 lang は `useT()` の現在 locale を渡す)。
 */

import type { SupportedLang } from "@tenkacloud/format";

export { formatRelativeTime, type SupportedLang } from "@tenkacloud/format";

const EVENT_STATUS_LABELS: Record<string, { ja: string; en: string }> = {
  DRAFT: { ja: "下書き", en: "Draft" },
  DEPLOYING: { ja: "デプロイ中", en: "Deploying" },
  READY: { ja: "準備完了", en: "Ready" },
  RUNNING: { ja: "競技中", en: "Running" },
  ENDED: { ja: "終了", en: "Ended" },
  TEARDOWN: { ja: "削除中", en: "Teardown" },
  ARCHIVED: { ja: "終了済", en: "Archived" },
};

/**
 * Event status enum → 表示ラベル。 未知 enum はそのまま返す (= debug fallback)。
 */
export function formatEventStatus(status: string, lang: SupportedLang = "ja"): string {
  const e = EVENT_STATUS_LABELS[status];
  return e ? e[lang] : status;
}

const ROLE_LABELS: Record<string, { ja: string; en: string }> = {
  SystemAdmin: { ja: "システム管理者", en: "System admin" },
  TenantAdmin: { ja: "テナント管理者", en: "Tenant admin" },
  TenantUser: { ja: "テナント利用者", en: "Tenant user" },
  BasicUser: { ja: "テナント利用者", en: "Tenant user" },
};

/**
 * SBT user role enum → 表示ラベル。 未知 enum はそのまま返す。
 */
export function formatRole(role: string, lang: SupportedLang = "ja"): string {
  const e = ROLE_LABELS[role];
  return e ? e[lang] : role;
}
