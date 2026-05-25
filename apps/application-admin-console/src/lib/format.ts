/**
 * Issue #1362: 用途別グルーピング + 表示加工 helpers。
 *
 * Qiita 記事 (https://qiita.com/mskmiki/items/544149987475719e417b) で言う
 * 「DB 生値そのまま表示」 を防ぐための pure formatter 群。
 *
 *   - `formatRelativeTime(iso)`   : ISO timestamp → 「2 時間前」「3 日前」 (= ユーザーが mental cast 不要)
 *   - `formatEventStatus(status)` : Event status enum → 日本語 / 英語のラベル (= "READY" → 「準備完了」)
 *   - `formatRole(role)`          : SBT user role enum → 日本語 / 英語ラベル
 *
 * 全て **言語切替に追従** するため引数で `lang` を受ける純粋関数。 React component 側は
 * `useT()` ではなく直接これを呼ぶ (= 引数 lang は `useT()` の現在 locale を渡す)。
 */

export type SupportedLang = "ja" | "en";

/**
 * ISO timestamp を 「N 分前 / N 時間前 / N 日前 / 今」 の人間可読形式に整形する。
 *
 * 境界:
 *   - 30 秒未満       → 「今」 / "just now"
 *   - 60 分未満        → 「N 分前」 / "N min ago"
 *   - 24 時間未満      → 「N 時間前」 / "N h ago"
 *   - 30 日未満        → 「N 日前」 / "N d ago"
 *   - それ以上          → ISO の日付部分 (YYYY-MM-DD)
 *
 * Invalid な ISO (= NaN) は "—" を返して UI を壊さない。 未来時刻は now との差を 0 に丸める
 * (= 「未来」 文言は出さない — Event スケジュールの「開始予定」 表示は別系統)。
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
  // 30 日以上前は ISO の日付部分のみ (= "2025-12-03")。
  return iso.slice(0, 10);
}

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
