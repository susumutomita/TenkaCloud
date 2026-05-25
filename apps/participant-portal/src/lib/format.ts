/**
 * Issue #1362: Qiita 原則 「DB 生値そのまま表示しない」 のための pure formatter。
 *
 * admin-console / application-admin-console 側にも同 API を置く (= mono-repo 内 3 SPA で
 * 同じ「N 分前」「ステータス和訳」 を再利用)。
 */

export type SupportedLang = "ja" | "en";

/**
 * ISO timestamp → 「N 分前 / N 時間前 / N 日前 / 今」 の人間可読形式。
 *
 * `describeAgo` (= score 専用 / 「N 秒前」 まで細かく見せる) とは別系統。 こちらは
 * 一般 UI (= 「最終ログイン」 「公開時刻」 等) 向けで 秒精度は出さない。
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

/**
 * Score events cell の hover tooltip 用「UTC + ローカル時刻」併記文字列。
 *
 * 一次情報は相対時刻 (= 「何分前」、即時 feedback) で十分、絶対時刻は **必要なときだけ**
 * 引きたいので tooltip に逃がす設計 (#548)。`Intl.DateTimeFormat` でブラウザ環境の
 * ローカル TZ を解決し、UTC ISO と並べて返す。Invalid な ISO は `?` で防御。
 */
export function formatOccurredAtTooltip(iso: string | undefined): string {
  if (!iso) return "未採点";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "?";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(ms).toLocaleString(undefined, { timeZone: tz });
  return `${iso}\n${local} (${tz})`;
}

/**
 * 「N 秒前 / N 分前 / N 時間 N 分前」の人間可読フォーマット。
 *
 * Battle 中の defender が score の停滞時間を察知するための display helper。
 * 答え (= どこの endpoint が壊れているか) は教えず、defender 自身に SSM Session 等
 * で原因を調査させる Battle ゲーム性のため、このヘルパーは「経過時間」だけを返す。
 */
export function describeAgo(sinceIso: string | undefined, nowMs: number): string {
  if (!sinceIso) return "未採点";
  const sinceMs = new Date(sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) return "?";
  const diff = Math.max(0, nowMs - sinceMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const hr = Math.floor(min / 60);
  return `${hr} 時間 ${min % 60} 分前`;
}
