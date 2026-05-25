/**
 * Markdown exporter for the Event Report page (`/events/:eventId/report`).
 *
 * 目的 (issue #1317):
 *   - 顧客への deliverable / Git 管理 / Wiki paste 用に GFM Markdown を export する。
 *   - 表は GFM table、 heading は `#` / `##` で構造化、 cover note は引用 prefix を付けず
 *     paragraph として埋め込む (= operator が後でメール本文に直接 paste できる)。
 *
 * 設計判断:
 *   - **pure function**: HTML exporter と同じ `EventReportExport` を受け取って文字列を返す。
 *   - **依存ゼロ**: `marked` などの library を入れず、 自前で paragraph / heading / GFM table
 *     を書き出す。 表の cell は GFM の都合上 `|` を escape する。
 *   - **改行ポリシー**: section 間は空行 1 行で分離。 末尾は改行 1 つで終わる
 *     (= POSIX text file の慣習に合わせる)。
 */

import type { EventReportExport } from "./html";

/** GFM table cell 用の escape: `|` と改行を escape する (HTML escape は不要)。 */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const head = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(escapeMarkdownCell).join(" | ")} |`).join("\n");
  return [head, sep, body].filter((s) => s.length > 0).join("\n");
}

function renderHeader(exp: EventReportExport): string {
  const { labels, eventName, tenantName, eventId, scheduleRange, status, generatedAt, coverNote } =
    exp;
  const metaRows: ReadonlyArray<readonly [string, string]> = [
    [labels.fieldOrganizer, tenantName],
    [labels.fieldEventId, `\`${eventId}\``],
    [labels.fieldSchedule, scheduleRange],
    [labels.fieldStatus, status],
    [labels.fieldGeneratedAt, `${generatedAt} UTC`],
  ];
  const meta = metaRows.map(([k, v]) => `- **${k}**: ${v}`).join("\n");
  return [
    `# ${exp.title}`,
    "",
    `## ${eventName}`,
    "",
    meta,
    "",
    `### ${labels.coverNoteLabel}`,
    "",
    coverNote,
  ].join("\n");
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
  return [`## ${labels.sectionSummary}`, "", renderTable(["Metric", "Value"], rows)].join("\n");
}

function renderScoreboard(exp: EventReportExport): string {
  const { scoreboard, labels } = exp;
  if (scoreboard.length === 0) {
    return [`## ${labels.sectionScoreboard}`, "", labels.scoreboardEmpty].join("\n");
  }
  const rows = scoreboard.map(
    (r) =>
      [
        String(r.rank),
        r.teamName,
        `${r.totalScore} pt`,
        String(r.problemsSolved),
      ] as readonly string[],
  );
  return [
    `## ${labels.sectionScoreboard}`,
    "",
    renderTable([labels.colRank, labels.colTeam, labels.colScore, labels.colProblemsSolved], rows),
  ].join("\n");
}

function renderBreakdown(exp: EventReportExport): string {
  const { breakdown, labels } = exp;
  if (breakdown.length === 0) {
    return [`## ${labels.sectionProblems}`, "", labels.problemsEmpty].join("\n");
  }
  const rows = breakdown.map(
    (r) =>
      [
        `\`${r.problemId}\``,
        r.defaultRegion,
        String(r.solvedCount),
        String(r.avgScore),
        `${r.successfulCount} / ${r.deploymentsCount}`,
      ] as readonly string[],
  );
  return [
    `## ${labels.sectionProblems}`,
    "",
    renderTable(
      [
        labels.colProblemId,
        labels.colRegion,
        labels.colSolvedCount,
        labels.colAvgScore,
        labels.colDeployments,
      ],
      rows,
    ),
  ].join("\n");
}

function renderDisruptions(exp: EventReportExport): string {
  const { disruptions, labels } = exp;
  if (disruptions.length === 0) return "";
  const rows = disruptions.map(
    (e) =>
      [
        e.occurredAt,
        e.teamName,
        `\`${e.problemId}\``,
        e.source,
        String(e.points),
      ] as readonly string[],
  );
  return [
    `## ${labels.sectionDisruptions}`,
    "",
    labels.disruptionsDescription,
    "",
    renderTable(
      [
        labels.colOccurredAt,
        labels.colTeam,
        labels.colProblemId,
        labels.colSource,
        labels.colPoints,
      ],
      rows,
    ),
  ].join("\n");
}

function renderFooter(exp: EventReportExport): string {
  return [
    `## ${exp.labels.sectionFooter}`,
    "",
    `${exp.labels.footerGeneratedBy} · ${exp.generatedAt} UTC`,
    "",
    exp.labels.footerBranding,
  ].join("\n");
}

/**
 * Pure function: build a GFM-flavored Markdown document for the Event Report.
 * Section ordering mirrors the on-screen render; disruption section is omitted
 * when there are no negative-point events.
 */
export function buildEventReportMarkdown(exp: EventReportExport): string {
  const body = [
    renderHeader(exp),
    renderSummary(exp),
    renderScoreboard(exp),
    renderBreakdown(exp),
    renderDisruptions(exp),
    renderFooter(exp),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  return `${body}\n`;
}
