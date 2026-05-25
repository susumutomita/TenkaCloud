/**
 * Issue #1362: 用途別グルーピング + 表示加工 helpers (admin-console 側)。
 *
 * application-admin-console/src/lib/format.ts と同じ pure formatter を copy-paste で複製。
 * 共通化は monorepo に shared package を切る大きな refactor が要るため、 まずは小さく揃える。
 *
 *   - `formatRelativeTime(iso)`        : ISO → 「N 分前」
 *   - `formatTenantStatus(status)`     : tenant status enum → label
 *   - `formatTier(tier)`               : SBT tier enum → label
 *
 * 全関数 pure。 React 側は現在 locale を引数で渡す。
 */

export type SupportedLang = "ja" | "en";

/**
 * ISO timestamp → 「2 時間前」 表示。 詳細仕様は application-admin-console の同名関数を参照。
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  lang: SupportedLang = "ja",
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const diff = Math.max(0, now.getTime() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return lang === "ja" ? "今" : "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return lang === "ja" ? `${min} 分前` : `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return lang === "ja" ? `${hr} 時間前` : `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return lang === "ja" ? `${day} 日前` : `${day} d ago`;
  return iso.slice(0, 10);
}

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
