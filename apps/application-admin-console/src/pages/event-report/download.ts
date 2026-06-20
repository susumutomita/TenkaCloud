/**
 * Blob + ephemeral anchor で client-side download をトリガーする util。
 *
 * exporter (HTML / Markdown) が吐いた文字列を file として保存させるための共通経路。
 * `URL.createObjectURL` を 1 tick 後に `revokeObjectURL` して memory を返す。
 * SSR (= jsdom 経由を含む) で document が居ない場合は no-op。
 */

export function triggerBlobDownload(content: string, mimeType: string, filename: string): void {
  // SPA では document / URL は常に存在 (= SSR 向け防御 guard、 不到達)。
  /* v8 ignore next */
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  // body に append しないとモバイル Safari で click が無視されることがある。
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 早期 revoke は Firefox で download が破棄されるので next tick で。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
