/**
 * Issue #1362 / #1446: 用途別グルーピング + 表示加工 helpers (admin-console 側)。
 *
 * 汎用の `formatRelativeTime` は #1446 で `@tenkacloud/format` に集約し、 ここからは
 * re-export して呼び出し元 (`from "../lib/format"`) を不変に保つ。 admin-console 固有の
 * label formatter (tenant status / tier = 別ドメイン) だけをこのファイルに残す。
 *
 *   - `formatRelativeTime(iso)`        : ISO → 「N 分前」 (= @tenkacloud/format 由来)
 *   - `formatTenantStatus(status)`     : tenant status enum → label
 *   - `formatTier(tier)`               : SBT tier enum → label
 *
 * 全関数 pure。 React 側は現在 locale を引数で渡す。
 */

import type { SupportedLang } from "@tenkacloud/format";

export { formatRelativeTime, type SupportedLang } from "@tenkacloud/format";

const TENANT_STATUS_LABELS: Record<string, { ja: string; en: string }> = {
  PROVISIONING: { ja: "プロビジョニング中", en: "Provisioning" },
  ACTIVE: { ja: "稼働中", en: "Active" },
  SUSPENDED: { ja: "停止中", en: "Suspended" },
  DELETING: { ja: "削除中", en: "Deleting" },
  DELETED: { ja: "削除済", en: "Deleted" },
};

export function formatTenantStatus(status: string, lang: SupportedLang = "ja"): string {
  const e = TENANT_STATUS_LABELS[status];
  return e ? e[lang] : status;
}

const TIER_LABELS: Record<string, { ja: string; en: string }> = {
  BASIC: { ja: "BASIC (プール)", en: "BASIC (pooled)" },
  STANDARD: { ja: "STANDARD (プール)", en: "STANDARD (pooled)" },
  PREMIUM: { ja: "PREMIUM (プール)", en: "PREMIUM (pooled)" },
  PLATINUM: { ja: "PLATINUM (サイロ)", en: "PLATINUM (silo)" },
};

export function formatTier(tier: string, lang: SupportedLang = "ja"): string {
  const e = TIER_LABELS[tier];
  return e ? e[lang] : tier;
}
