/**
 * Print CSS for the Event Report page (`/events/:eventId/report`).
 *
 * 設計判断:
 *   - **inline `<style>` 注入**: report page だけが load する component-scoped CSS。
 *     global stylesheet を増やすと他 SPA / 他 page にも漏れるので、 page mount 時のみ
 *     `<style>` を head 末尾に append し unmount 時に remove する。
 *   - **whitelist 戦略 (issue #1317)**: 旧 `display: none !important` の "黒リスト" 方式は
 *     Cloudscape の hash 化された container を狙っていたが、 chrome の構造変更や React
 *     portal の絡みで先に対象 div が DOM から外れていると report 本体まで巻き込んで
 *     非表示にしてしまい、 print preview が空白になる問題があった。 そこで:
 *
 *       1. `body *` を `visibility: hidden` で一括非表示
 *       2. `.event-report-page` 自身とその子孫だけを `visibility: visible` で表示
 *       3. `.event-report-page` を `position: absolute; top:0; left:0; width:100%` で
 *          ページ左上に固定し、 残骸の box が裏で space を取っても layout から見て
 *          見えない (visibility: hidden は box は残るが描画されない) ので余白だけ済む
 *
 *     という visibility-whitelist にする。 chrome がどこで render されようと、 report 配下
 *     にいない限り print に出ない。
 *   - **page-break**: section 間で `page-break-before: always`、 card / table 内では
 *     `page-break-inside: avoid` でカード途中で改ページしないようにする。
 *   - **serif font + grayscale**: print-readability 優先。 Noto Serif JP + Georgia の
 *     stack で和欧文を揃え、 zebra 縞は `#f0f0f0` の薄 grey で color 依存を避ける。
 */

export const EVENT_REPORT_PRINT_CSS = `
@media print {
  /* 1) 既定で全要素を非表示 (visibility は box は残すが描画されない)。 */
  body * {
    visibility: hidden;
  }
  /* 2) report root とその子孫だけを可視化。 */
  .event-report-page,
  .event-report-page * {
    visibility: visible;
  }
  /* 3) report root を A4 ページ左上に固定し、 残骸の box の影響を消す。 */
  .event-report-page {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    margin: 0 !important;
    padding: 12mm 14mm !important;
    color: #000 !important;
    background: #fff !important;
    font-family: "Noto Serif JP", Georgia, "Times New Roman", serif !important;
    font-size: 10pt !important;
    line-height: 1.5 !important;
  }
  /* operator 用の編集 UI / button group は印刷から外す。 */
  .event-report-page [data-tenkacloud-print-no-print] {
    display: none !important;
  }
  /* section 単位で改ページ制御。 */
  [data-tenkacloud-print-section] {
    page-break-inside: avoid;
    margin-top: 8mm;
  }
  [data-tenkacloud-print-section-break] {
    page-break-before: always;
  }
  /* table style. */
  [data-tenkacloud-print-table] {
    width: 100%;
    border-collapse: collapse;
    page-break-inside: auto;
  }
  [data-tenkacloud-print-table] th,
  [data-tenkacloud-print-table] td {
    border: 1px solid #444;
    padding: 4pt 6pt;
    text-align: left;
    vertical-align: top;
  }
  [data-tenkacloud-print-table] th {
    background: #ddd !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  [data-tenkacloud-print-table] tr:nth-child(even) td {
    background: #f0f0f0 !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* デフォルト A4 縦。 operator が browser print preview から landscape に切替可能。 */
  @page {
    size: A4 portrait;
    margin: 10mm;
  }
}
`;

/** 主要 selector を snapshot test で固定するための一覧。 順序固定。 */
export const EVENT_REPORT_PRINT_SELECTORS = [
  "body *",
  ".event-report-page",
  ".event-report-page *",
  "[data-tenkacloud-print-section]",
  "[data-tenkacloud-print-section-break]",
  "[data-tenkacloud-print-table]",
  "[data-tenkacloud-print-no-print]",
  "@page",
] as const;
