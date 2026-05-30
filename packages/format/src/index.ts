/**
 * @tenkacloud/format — Issue #1446: TenkaCloud の 3 SPA (participant-portal /
 * admin-console / application-admin-console) で copy-paste されていた pure formatter の
 * 単一の正本。 React 非依存の純関数なので、 既存の `auth-client` / `problem-runtime` と同じ
 * 「ソースを直接 import する workspace package」 形で共有する。
 *
 * 各 SPA は app 固有の label formatter (status / role / tier 等、 別ドメイン) は自前の
 * `lib/format.ts` に残し、 ここからは `formatRelativeTime` を re-export して呼び出し元を不変に保つ。
 */

export type SupportedLang = "ja" | "en";

/**
 * ISO timestamp を 「N 分前 / N 時間前 / N 日前 / 今」 の人間可読形式に整形する。
 *
 * 境界:
 *   - 30 秒未満   → 「今」 / "just now"
 *   - 60 分未満   → 「N 分前」 / "N min ago"
 *   - 24 時間未満 → 「N 時間前」 / "N h ago"
 *   - 30 日未満   → 「N 日前」 / "N d ago"
 *   - それ以上    → ISO の日付部分 (YYYY-MM-DD)
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
  return iso.slice(0, 10);
}
