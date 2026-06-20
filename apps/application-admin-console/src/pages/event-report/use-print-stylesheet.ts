/**
 * Event Report ページ専用の print CSS を head に動的注入する hook。
 *
 * report mount 時に `<style>` を `document.head` に挿し、 unmount 時に外す
 * (= `@media print` が他 page に漏れない)。 既に同 id の style が居れば再利用
 * (= StrictMode の double-mount でも 1 つだけ)。 print CSS 本体は
 * `lib/event-report-print-css.ts`。
 */

import { useEffect } from "react";
import { EVENT_REPORT_PRINT_CSS } from "../../lib/event-report-print-css";

export const PRINT_STYLE_ID = "tenkacloud-event-report-print-style";

export function usePrintStylesheet(): void {
  useEffect(() => {
    // SPA (SSR なし) なので document は常に存在 (= この guard は不到達、防御)。
    /* v8 ignore next */
    if (typeof document === "undefined") return;
    let style = document.getElementById(PRINT_STYLE_ID) as HTMLStyleElement | null;
    let owned = false;
    if (!style) {
      style = document.createElement("style");
      style.id = PRINT_STYLE_ID;
      style.textContent = EVENT_REPORT_PRINT_CSS;
      document.head.appendChild(style);
      owned = true;
    }
    return () => {
      if (owned && style?.parentNode) style.parentNode.removeChild(style);
    };
  }, []);
}
