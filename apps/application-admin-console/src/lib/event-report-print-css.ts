/**
 * Print CSS for the Event Report page (`/events/:eventId/report`).
 *
 * 設計判断:
 *   - **inline `<style>` 注入**: report page だけが load する component-scoped CSS。
 *     global stylesheet を増やすと他 SPA / 他 page にも漏れるので、 page mount 時のみ
 *     `<style>` を head 末尾に append し unmount 時に remove する。
 *   - **selector 戦略**: Cloudscape の TopNavigation / SideNavigation は class 名が
 *     hash 化されていて掴みにくいので、 安定した DOM 構造 (= `<header>` element, side
 *     navigation の `nav[aria-labelledby^=awsui-side-navigation]`) を狙う。 加えて
 *     report 自身に `data-tenkacloud-print-root` 属性を立て、 print 時はこれ以外を全部
 *     隠す `body > *:not(...)` 系の strategy で漏れを防ぐ。
 *   - **page-break**: section 間で `page-break-before: always`、 card / table 内では
 *     `page-break-inside: avoid` でカード途中で改ページしないようにする。
 *   - **serif font + grayscale**: print-readability 優先。 Noto Serif JP + Georgia の
 *     stack で和欧文を揃え、 zebra 縞は `#f0f0f0` の薄 grey で color 依存を避ける。
 */

export const EVENT_REPORT_PRINT_CSS = `
@media print {
  /* TopNavigation / SideNavigation / Cloudscape AppLayout chrome を完全に隠す。 */
  header[id^="awsui"],
  nav[aria-labelledby^="awsui-side-navigation"],
  [data-testid="app-layout-navigation"],
  [class*="awsui_navigation"],
  [class*="awsui_tools"],
  [class*="awsui_breadcrumbs"],
  [class*="awsui_notifications"] {
    display: none !important;
  }
  /* AppLayout の content padding を 0 にして A4 に合わせる。 */
  [class*="awsui_layout-wrapper"],
  [class*="awsui_content-wrapper"],
  [class*="awsui_content"] {
    padding: 0 !important;
    margin: 0 !important;
  }
  /* report root だけ表示。 他の sibling は念のため hide。 */
  body > *:not([data-tenkacloud-print-root]):not(style):not(script) {
    display: none !important;
  }
  [data-tenkacloud-print-root] {
    display: block !important;
    margin: 0 !important;
    padding: 12mm 14mm !important;
    color: #000 !important;
    background: #fff !important;
    font-family: "Noto Serif JP", Georgia, "Times New Roman", serif !important;
    font-size: 10pt !important;
    line-height: 1.5 !important;
  }
  [data-tenkacloud-print-section] {
    page-break-inside: avoid;
    margin-top: 8mm;
  }
  [data-tenkacloud-print-section-break] {
    page-break-before: always;
  }
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
  [data-tenkacloud-print-no-print] {
    display: none !important;
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
  'header[id^="awsui"]',
  'nav[aria-labelledby^="awsui-side-navigation"]',
  "body > *:not([data-tenkacloud-print-root]):not(style):not(script)",
  "[data-tenkacloud-print-root]",
  "[data-tenkacloud-print-section]",
  "[data-tenkacloud-print-section-break]",
  "[data-tenkacloud-print-table]",
  "[data-tenkacloud-print-no-print]",
  "@page",
] as const;
