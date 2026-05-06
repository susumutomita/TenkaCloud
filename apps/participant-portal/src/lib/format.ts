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
