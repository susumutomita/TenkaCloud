/**
 * HTML exporter for the Event Report page (`/events/:eventId/report`).
 *
 * 目的 (issue #1317):
 *   - browser の Print-to-PDF は margin / page-break / font / background-graphics で
 *     fragile なので、 顧客向け deliverable には self-contained な HTML を主流にする。
 *   - 「1 ファイルで開ける、 inline CSS、 画像不要」 を必須要件にし、 mail 添付 / Git
 *     管理 / re-render どれも 1 file で完結する。
 *
 * 設計判断:
 *   - **pure function**: React 依存ゼロ。 統計は `lib/event-report-stats.ts` で前計算した
 *     `EventReportExport` (data interface) を受け取り、 文字列を吐くだけ。 ViewModel と
 *     output format の責務分離。
 *   - **i18n は呼び出し側**: ヘッダ / column 名等の表示文字列は `EventReportExport.labels`
 *     経由で渡す (= page 側が `useT()` で解決済みのものを注入)。 exporter が `t()` を
 *     直接呼ばないのは、 ja/en 切替の責務を page 層に閉じるため。
 *   - **escaping**: HTML entity escape (`&`, `<`, `>`, `"`, `'`) を 1 関数で集中。 cover note
 *     は operator が自由記入できる 入力なので必ず escape して `dangerouslySetInnerHTML`
 *     相当の XSS 経路を作らない。
 *   - **serif font + A4-ish margins**: print CSS と同じ Noto Serif JP / Georgia stack。
 *     `@page { size: A4; margin: 14mm }` で browser で開いて即 Print to PDF できる。
 *
 * 形式:
 *
 *     <!doctype html>
 *     <html lang="...">
 *       <head>
 *         <meta charset="utf-8">
 *         <title>...</title>
 *         <style>...inline...</style>
 *       </head>
 *       <body>
 *         <main class="event-report-page">
 *           <section> ... 6 sections ... </section>
 *         </main>
 *       </body>
 *     </html>
 */

import type {
  DisruptionEntry,
  EventReportSummary,
  ProblemBreakdownRow,
  ScoreboardRow,
} from "../../../lib/event-report-stats";

/**
 * Exporter への入力。 page 側で computed view-model + i18n 解決済 label を詰める。
 *
 * 「label を string で受け取る」 のは exporter が i18n / data 取得を持ち込まないため。
 * (= 同じ data から ja / en どちらの export も再現可能)。
 */
export interface EventReportExport {
  readonly locale: "ja" | "en";
  readonly title: string;
  readonly eventName: string;
  readonly eventId: string;
  readonly tenantName: string;
  readonly scheduleRange: string;
  readonly status: string;
  readonly generatedAt: string;
  readonly coverNote: string;
  readonly summary: EventReportSummary;
  readonly scoreboard: readonly ScoreboardRow[];
  readonly breakdown: readonly ProblemBreakdownRow[];
  readonly disruptions: readonly DisruptionEntry[];
  readonly labels: EventReportLabels;
}

export interface EventReportLabels {
  readonly fieldOrganizer: string;
  readonly fieldEventId: string;
  readonly fieldSchedule: string;
  readonly fieldStatus: string;
  readonly fieldGeneratedAt: string;
  readonly coverNoteLabel: string;
  readonly sectionSummary: string;
  readonly sectionScoreboard: string;
  readonly sectionProblems: string;
  readonly sectionDisruptions: string;
  readonly sectionFooter: string;
  readonly statTeams: string;
  readonly statParticipants: string;
  readonly statProblems: string;
  readonly statTotalDeployments: string;
  readonly statSuccessRate: string;
  /** プレフォーマット済の "{ok} ok / {failed} failed" (= page 側で interpolate)。 */
  readonly statSuccessRateBreakdown: string;
  readonly colRank: string;
  readonly colTeam: string;
  readonly colScore: string;
  readonly colProblemsSolved: string;
  readonly colProblemId: string;
  readonly colRegion: string;
  readonly colSolvedCount: string;
  readonly colAvgScore: string;
  readonly colDeployments: string;
  readonly colOccurredAt: string;
  readonly colSource: string;
  readonly colPoints: string;
  readonly scoreboardEmpty: string;
  readonly problemsEmpty: string;
  readonly disruptionsDescription: string;
  readonly footerGeneratedBy: string;
  readonly footerBranding: string;
  /** "57.1%" 等の successRate 表示文字列 (= 呼び出し側で formatPercent 済)。 */
  readonly successRateFormatted: string;
}

/** HTML entity escape。 attribute / text node 双方で安全な 5 文字を escape。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** event-report の body container class。 print-css と HTML export で同じ class を使う。 */
export const EVENT_REPORT_PAGE_CLASS = "event-report-page";

/** browser で開いてそのまま print-to-PDF 可能な inline CSS。 print 用 selector は HTML export では使わない (chrome 不在のため)。 */
const INLINE_CSS = `
  body { margin: 0; background: #fff; color: #000;
    font-family: "Noto Serif JP", Georgia, "Times New Roman", serif;
    font-size: 11pt; line-height: 1.55; }
  .event-report-page { max-width: 800px; margin: 0 auto;
    padding: 14mm 16mm; }
  h1 { font-size: 24pt; margin: 0 0 0.25rem 0; }
  h2 { font-size: 16pt; margin: 1.5rem 0 0.5rem 0; border-bottom: 1px solid #999; padding-bottom: 0.15rem; }
  h3 { font-size: 13pt; margin: 1rem 0 0.25rem 0; }
  dl.event-report-meta { display: grid; grid-template-columns: max-content 1fr;
    gap: 4px 12px; margin: 0.5rem 0 1rem 0; }
  dl.event-report-meta dt { font-weight: 600; color: #333; }
  dl.event-report-meta dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
  th, td { border: 1px solid #555; padding: 4pt 6pt; text-align: left;
    vertical-align: top; }
  th { background: #ddd; }
  tr:nth-child(even) td { background: #f3f3f3; }
  code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.92em; }
  .event-report-cover-note { white-space: pre-wrap; margin: 0.5rem 0 1rem 0;
    padding: 0.5rem 0.75rem; border-left: 3px solid #888; background: #fafafa; }
  .event-report-footer { margin-top: 2rem; border-top: 1px solid #888;
    padding-top: 0.5rem; font-size: 0.92em; color: #444; }
  @page { size: A4; margin: 14mm; }
`;

/**
 * Meta list 用の row 型: ddRaw を `"text"` で渡すと escape する、 `{ html: ... }` で
 * 渡すと既に safe な HTML として扱う (= eventId は `<code>` で囲みたいのでこれを使う)。
 */
type MetaRow = readonly [label: string, ddRaw: string | { readonly safeHtml: string }];

function renderMetaList(exp: EventReportExport): string {
  const { labels } = exp;
  const rows: readonly MetaRow[] = [
    [labels.fieldOrganizer, exp.tenantName],
    [labels.fieldEventId, { safeHtml: `<code>${escapeHtml(exp.eventId)}</code>` }],
    [labels.fieldSchedule, exp.scheduleRange],
    [labels.fieldStatus, exp.status],
    [labels.fieldGeneratedAt, `${exp.generatedAt} UTC`],
  ];
  const items = rows
    .map(([label, value]) => {
      const dd = typeof value === "string" ? escapeHtml(value) : value.safeHtml;
      return `    <dt>${escapeHtml(label)}</dt>\n    <dd>${dd}</dd>`;
    })
    .join("\n");
  return `<dl class="event-report-meta">\n${items}\n  </dl>`;
}

function renderSummary(exp: EventReportExport): string {
  const { summary, labels } = exp;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [labels.statTeams, String(summary.teamCount)],
    [labels.statParticipants, String(summary.participantCount)],
    [labels.statProblems, String(summary.problemCount)],
    [labels.statTotalDeployments, String(summary.totalDeployments)],
    [labels.statSuccessRate, `${labels.successRateFormatted} (${labels.statSuccessRateBreakdown})`],
  ];
  const body = rows
    .map(
      ([head, value]) =>
        `        <tr><th scope="row">${escapeHtml(head)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("\n");
  return `<section aria-label="${escapeHtml(labels.sectionSummary)}">
    <h2>${escapeHtml(labels.sectionSummary)}</h2>
    <table>
      <tbody>
${body}
      </tbody>
    </table>
  </section>`;
}

function renderScoreboard(exp: EventReportExport): string {
  const { scoreboard, labels } = exp;
  if (scoreboard.length === 0) {
    return `<section aria-label="${escapeHtml(labels.sectionScoreboard)}">
    <h2>${escapeHtml(labels.sectionScoreboard)}</h2>
    <p>${escapeHtml(labels.scoreboardEmpty)}</p>
  </section>`;
  }
  const rows = scoreboard
    .map(
      (r) =>
        `        <tr><td>${r.rank}</td><td>${escapeHtml(r.teamName)}</td><td>${r.totalScore} pt</td><td>${r.problemsSolved}</td></tr>`,
    )
    .join("\n");
  return `<section aria-label="${escapeHtml(labels.sectionScoreboard)}">
    <h2>${escapeHtml(labels.sectionScoreboard)}</h2>
    <table>
      <thead>
        <tr><th>${escapeHtml(labels.colRank)}</th><th>${escapeHtml(labels.colTeam)}</th><th>${escapeHtml(labels.colScore)}</th><th>${escapeHtml(labels.colProblemsSolved)}</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderBreakdown(exp: EventReportExport): string {
  const { breakdown, labels } = exp;
  if (breakdown.length === 0) {
    return `<section aria-label="${escapeHtml(labels.sectionProblems)}">
    <h2>${escapeHtml(labels.sectionProblems)}</h2>
    <p>${escapeHtml(labels.problemsEmpty)}</p>
  </section>`;
  }
  const rows = breakdown
    .map(
      (r) =>
        `        <tr><td><code>${escapeHtml(r.problemId)}</code></td><td>${escapeHtml(r.defaultRegion)}</td><td>${r.solvedCount}</td><td>${r.avgScore}</td><td>${r.successfulCount} / ${r.deploymentsCount}</td></tr>`,
    )
    .join("\n");
  return `<section aria-label="${escapeHtml(labels.sectionProblems)}">
    <h2>${escapeHtml(labels.sectionProblems)}</h2>
    <table>
      <thead>
        <tr><th>${escapeHtml(labels.colProblemId)}</th><th>${escapeHtml(labels.colRegion)}</th><th>${escapeHtml(labels.colSolvedCount)}</th><th>${escapeHtml(labels.colAvgScore)}</th><th>${escapeHtml(labels.colDeployments)}</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderDisruptions(exp: EventReportExport): string {
  const { disruptions, labels } = exp;
  if (disruptions.length === 0) return "";
  const rows = disruptions
    .map(
      (e) =>
        `        <tr><td>${escapeHtml(e.occurredAt)}</td><td>${escapeHtml(e.teamName)}</td><td><code>${escapeHtml(e.problemId)}</code></td><td>${escapeHtml(e.source)}</td><td>${e.points}</td></tr>`,
    )
    .join("\n");
  return `<section aria-label="${escapeHtml(labels.sectionDisruptions)}">
    <h2>${escapeHtml(labels.sectionDisruptions)}</h2>
    <p>${escapeHtml(labels.disruptionsDescription)}</p>
    <table>
      <thead>
        <tr><th>${escapeHtml(labels.colOccurredAt)}</th><th>${escapeHtml(labels.colTeam)}</th><th>${escapeHtml(labels.colProblemId)}</th><th>${escapeHtml(labels.colSource)}</th><th>${escapeHtml(labels.colPoints)}</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderFooter(exp: EventReportExport): string {
  const { labels, generatedAt } = exp;
  return `<section class="event-report-footer" aria-label="${escapeHtml(labels.sectionFooter)}">
    <p>${escapeHtml(labels.footerGeneratedBy)} · ${escapeHtml(generatedAt)} UTC</p>
    <p>${escapeHtml(labels.footerBranding)}</p>
  </section>`;
}

/**
 * Pure function: build a self-contained HTML document (<!doctype html>…) for the
 * Event Report. Always emits exactly 5 main sections + 6th (= disruption) only when
 * `disruptions.length > 0`, matching the on-screen render.
 */
export function buildEventReportHtml(exp: EventReportExport): string {
  const { labels, coverNote, title, eventName, locale } = exp;
  const langAttr = locale === "ja" ? "ja" : "en";
  const documentTitle = `${title} — ${eventName}`;
  const header = `<section aria-label="${escapeHtml(title)}">
    <h1>${escapeHtml(title)}</h1>
    <h2>${escapeHtml(eventName)}</h2>
    ${renderMetaList(exp)}
    <h3>${escapeHtml(labels.coverNoteLabel)}</h3>
    <p class="event-report-cover-note">${escapeHtml(coverNote)}</p>
  </section>`;
  const body = [
    header,
    renderSummary(exp),
    renderScoreboard(exp),
    renderBreakdown(exp),
    renderDisruptions(exp),
    renderFooter(exp),
  ]
    .filter((s) => s.length > 0)
    .join("\n  ");

  return `<!doctype html>
<html lang="${langAttr}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(documentTitle)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<main class="${EVENT_REPORT_PAGE_CLASS}">
  ${body}
</main>
</body>
</html>
`;
}
