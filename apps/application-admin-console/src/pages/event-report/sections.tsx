/**
 * Event Report ページのプレゼンテーション用 sub-component 群。
 *
 * page (`EventReport.tsx`) は data 取得 / state 保持 / ViewModel 組み立ての orchestrator に
 * 専念し、 「画面に何を描くか」 はここに閉じる。 各 section は props だけを受け取る純粋な
 * 表示コンポーネント。 print 用の `data-tenkacloud-print-*` 属性もここで付与する。
 */

import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import type { EventDetail } from "../../api/events-client";
import {
  type DisruptionEntry,
  formatPercent,
  type ProblemBreakdownRow,
  type ScoreboardRow,
  type summarizeEvent,
} from "../../lib/event-report-stats";
import { triggerBlobDownload } from "./download";
import type { Translate } from "./export-view";
import type { EventReportExport } from "./exporters/html";
import { buildEventReportHtml } from "./exporters/html";
import { buildEventReportMarkdown } from "./exporters/markdown";
import { formatDate, formatScheduleRange } from "./formatters";

export function PrintControls({
  eventId,
  exportView,
  navigateBack,
  t,
}: {
  readonly eventId: string;
  readonly exportView: EventReportExport;
  readonly navigateBack: () => void;
  readonly t: Translate;
}) {
  return (
    <div data-tenkacloud-print-no-print="true" style={{ marginBottom: "1rem" }}>
      <SpaceBetween direction="horizontal" size="xs">
        <Button onClick={navigateBack}>{t("event_report.back")}</Button>
        <Button
          variant="primary"
          iconName="download"
          data-testid="event-report-download-html"
          onClick={() => {
            triggerBlobDownload(
              buildEventReportHtml(exportView),
              "text/html;charset=utf-8",
              `event-${eventId}.html`,
            );
          }}
        >
          {t("event_report.download_html_button")}
        </Button>
        <Button
          variant="primary"
          iconName="download"
          data-testid="event-report-download-md"
          onClick={() => {
            triggerBlobDownload(
              buildEventReportMarkdown(exportView),
              "text/markdown;charset=utf-8",
              `event-${eventId}.md`,
            );
          }}
        >
          {t("event_report.download_md_button")}
        </Button>
        <Button
          variant="normal"
          iconName="file"
          data-testid="event-report-print-button"
          onClick={() => {
            // SPA では window は常に存在 (= SSR 向け防御 guard の偽分岐は不到達)。
            /* v8 ignore next */
            if (typeof window !== "undefined") window.print();
          }}
        >
          {t("event_report.print_button")}
        </Button>
      </SpaceBetween>
    </div>
  );
}

export function HeaderSection({
  coverNote,
  detail,
  generatedAt,
  onCoverNoteChange,
  t,
  tenantName,
}: {
  readonly coverNote: string;
  readonly detail: EventDetail;
  readonly generatedAt: string;
  readonly onCoverNoteChange: (value: string) => void;
  readonly t: Translate;
  readonly tenantName: string;
}) {
  return (
    <section data-tenkacloud-print-section="true" aria-label={t("event_report.section_header")}>
      <h1 style={{ marginBottom: "0.25rem" }}>{t("event_report.title")}</h1>
      <h2 style={{ marginTop: 0 }}>{detail.name}</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px" }}>
        <dt>{t("event_report.field_organizer")}</dt>
        <dd>{tenantName}</dd>
        <dt>{t("event_report.field_event_id")}</dt>
        <dd>
          <code>{detail.eventId}</code>
        </dd>
        <dt>{t("event_report.field_schedule")}</dt>
        <dd>{formatScheduleRange(detail)}</dd>
        <dt>{t("event_report.field_status")}</dt>
        <dd>{detail.status}</dd>
        <dt>{t("event_report.field_generated_at")}</dt>
        <dd>{generatedAt} UTC</dd>
      </dl>
      <div style={{ marginTop: "1rem" }}>
        <strong>{t("event_report.cover_note_label")}</strong>
        <div data-tenkacloud-print-no-print="true" style={{ marginTop: "0.25rem" }}>
          <Textarea
            value={coverNote}
            onChange={({ detail: d }) => onCoverNoteChange(d.value)}
            placeholder={t("event_report.cover_note_placeholder")}
            rows={4}
            ariaLabel={t("event_report.cover_note_label")}
          />
        </div>
        <p
          data-testid="event-report-cover-note"
          style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}
        >
          {coverNote}
        </p>
      </div>
    </section>
  );
}

export function SummarySection({
  summary,
  t,
}: {
  readonly summary: ReturnType<typeof summarizeEvent>;
  readonly t: Translate;
}) {
  return (
    <section
      data-tenkacloud-print-section="true"
      data-tenkacloud-print-section-break="true"
      aria-label={t("event_report.section_summary")}
    >
      <h2>{t("event_report.section_summary")}</h2>
      <table data-tenkacloud-print-table="true">
        <tbody>
          <tr>
            <th scope="row">{t("event_report.stat_teams")}</th>
            <td>{summary.teamCount}</td>
          </tr>
          <tr>
            <th scope="row">{t("event_report.stat_participants")}</th>
            <td>{summary.participantCount}</td>
          </tr>
          <tr>
            <th scope="row">{t("event_report.stat_problems")}</th>
            <td>{summary.problemCount}</td>
          </tr>
          <tr>
            <th scope="row">{t("event_report.stat_total_deployments")}</th>
            <td>{summary.totalDeployments}</td>
          </tr>
          <tr>
            <th scope="row">{t("event_report.stat_success_rate")}</th>
            <td>
              {formatPercent(summary.successRate)} (
              {t("event_report.stat_success_rate_breakdown", {
                ok: summary.successfulDeployments,
                failed: summary.failedDeployments,
              })}
              )
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function ScoreboardSection({
  rows,
  t,
}: {
  readonly rows: readonly ScoreboardRow[];
  readonly t: Translate;
}) {
  return (
    <section
      data-tenkacloud-print-section="true"
      data-tenkacloud-print-section-break="true"
      aria-label={t("event_report.section_scoreboard")}
    >
      <h2>{t("event_report.section_scoreboard")}</h2>
      {rows.length === 0 ? (
        <p>{t("event_report.scoreboard_empty")}</p>
      ) : (
        <table data-tenkacloud-print-table="true">
          <thead>
            <tr>
              <th>{t("event_report.col_rank")}</th>
              <th>{t("event_report.col_team")}</th>
              <th>{t("event_report.col_score")}</th>
              <th>{t("event_report.col_problems_solved")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.teamId}>
                <td>{row.rank}</td>
                <td>{row.teamName}</td>
                <td>{row.totalScore} pt</td>
                <td>{row.problemsSolved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ProblemBreakdownSection({
  rows,
  t,
}: {
  readonly rows: readonly ProblemBreakdownRow[];
  readonly t: Translate;
}) {
  return (
    <section
      data-tenkacloud-print-section="true"
      data-tenkacloud-print-section-break="true"
      aria-label={t("event_report.section_problems")}
    >
      <h2>{t("event_report.section_problems")}</h2>
      {rows.length === 0 ? (
        <p>{t("event_report.problems_empty")}</p>
      ) : (
        <table data-tenkacloud-print-table="true">
          <thead>
            <tr>
              <th>{t("event_report.col_problem_id")}</th>
              <th>{t("event_report.col_region")}</th>
              <th>{t("event_report.col_solved_count")}</th>
              <th>{t("event_report.col_avg_score")}</th>
              <th>{t("event_report.col_deployments")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.problemId}>
                <td>
                  <code>{row.problemId}</code>
                </td>
                <td>{row.defaultRegion}</td>
                <td>{row.solvedCount}</td>
                <td>{row.avgScore}</td>
                <td>
                  {row.successfulCount} / {row.deploymentsCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function DisruptionSection({
  entries,
  t,
}: {
  readonly entries: readonly DisruptionEntry[];
  readonly t: Translate;
}) {
  return (
    <section
      data-tenkacloud-print-section="true"
      data-tenkacloud-print-section-break="true"
      aria-label={t("event_report.section_disruptions")}
    >
      <h2>{t("event_report.section_disruptions")}</h2>
      <p>{t("event_report.disruptions_description")}</p>
      <table data-tenkacloud-print-table="true">
        <thead>
          <tr>
            <th>{t("event_report.col_occurred_at")}</th>
            <th>{t("event_report.col_team")}</th>
            <th>{t("event_report.col_problem_id")}</th>
            <th>{t("event_report.col_source")}</th>
            <th>{t("event_report.col_points")}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.occurredAt}-${entry.teamId}-${entry.problemId}`}>
              <td>{formatDate(entry.occurredAt)}</td>
              <td>{entry.teamName}</td>
              <td>
                <code>{entry.problemId}</code>
              </td>
              <td>{entry.source}</td>
              <td>{entry.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function FooterSection({
  generatedAt,
  t,
}: {
  readonly generatedAt: string;
  readonly t: Translate;
}) {
  return (
    <section
      data-tenkacloud-print-section="true"
      aria-label={t("event_report.section_footer")}
      style={{ marginTop: "2rem", borderTop: "1px solid #888", paddingTop: "0.5rem" }}
    >
      <p>
        {t("event_report.footer_generated_by")} · {generatedAt} UTC
      </p>
      <p>{t("event_report.footer_branding")}</p>
    </section>
  );
}
