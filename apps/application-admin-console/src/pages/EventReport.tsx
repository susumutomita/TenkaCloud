/**
 * Event Report page (`/events/:eventId/report`).
 *
 * Hosted Event 顧客 / Annual Arena Year-end recap への deliverable。 operator が競技
 * 終了後に開き、 browser の Print to PDF で PDF 化して顧客に渡す。
 *
 * 設計判断:
 *   - **single-fetch**: status が ENDED/ARCHIVED の event 対象なので polling 不要。
 *     useEventDetail (= 既存 hook) を 1 回だけ呼ぶ。
 *   - **print CSS は component-scoped**: report mount 時に `<style>` を head に注入し、
 *     unmount 時に外す (= 他 page に @media print が漏れない)。詳細は
 *     `lib/event-report-print-css.ts`。
 *   - **無依存 PDF**: bundle size を抑えるため PDF 生成 library は入れず browser native
 *     の Print Preview に任せる。 print 中の chrome (= TopNav / SideNav / 「印刷」 button)
 *     は `data-tenkacloud-print-no-print` で hide。
 *   - **cover note**: operator が自由記入できる intro paragraph。 component state で
 *     保持 (= サーバ永続化はしない; 印刷直前に書いて出すだけ)。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Textarea from "@cloudscape-design/components/textarea";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import { EVENT_ID_RE, type EventDetail } from "../api/events-client";
import type { AppConfig } from "../config";
import { useEventDetail } from "../hooks/useEventDetail";
import { type LocaleCode, useI18n } from "../i18n";
import { EVENT_REPORT_PRINT_CSS } from "../lib/event-report-print-css";
import {
  buildDisruptionLog,
  buildProblemBreakdown,
  buildScoreboard,
  type DisruptionEntry,
  formatPercent,
  type ProblemBreakdownRow,
  type ScoreboardRow,
  summarizeEvent,
} from "../lib/event-report-stats";
import {
  buildEventReportHtml,
  EVENT_REPORT_PAGE_CLASS,
  type EventReportExport,
  type EventReportLabels,
} from "./event-report/exporters/html";
import { buildEventReportMarkdown } from "./event-report/exporters/markdown";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const PRINT_STYLE_ID = "tenkacloud-event-report-print-style";

/**
 * print CSS を head に動的注入する。 既に同 id の style が居れば再利用 (= StrictMode の
 * double-mount でも 1 つだけ)。 unmount 時に remove。
 */
function usePrintStylesheet(): void {
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

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return `${new Date(ts).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatScheduleRange(detail: EventDetail): string {
  const startsAt = formatDate(detail.startsAt);
  const endsAt = formatDate(detail.endsAt);
  return `${startsAt} — ${endsAt}`;
}

export function EventReportPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const apiClient = useApiClient(config);
  const eventIdValid = !!eventId && EVENT_ID_RE.test(eventId);

  const { detail, error } = useEventDetail({
    apiClient,
    eventId,
    eventIdValid,
  });

  usePrintStylesheet();

  if (!eventIdValid || !eventId) {
    return <Navigate to="/events" replace />;
  }

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("event_report.loading")}
      </Box>
    );
  }

  if (!detail) {
    // loading guard を抜けて detail が無い時点で error は必ず truthy (= ?? の右辺は防御、不到達)。
    /* v8 ignore next */
    const errorBody = error ?? t("event_report.error_unknown");
    return (
      <Alert type="error" header={t("event_report.error_header")}>
        {errorBody}
      </Alert>
    );
  }

  return (
    <EventReportLoaded
      config={config}
      detail={detail}
      navigateBack={() => navigate(`/events/${eventId}`)}
      t={t}
      locale={locale}
    />
  );
}

function EventReportLoaded({
  config,
  detail,
  navigateBack,
  t,
  locale,
}: {
  readonly config: AppConfig;
  readonly detail: EventDetail;
  readonly navigateBack: () => void;
  readonly t: Translate;
  readonly locale: LocaleCode;
}) {
  const [coverNote, setCoverNote] = useState<string>(t("event_report.cover_note_default"));

  const summary = useMemo(() => summarizeEvent(detail), [detail]);
  const scoreboard = useMemo(
    () => buildScoreboard(detail.teams, detail.scoreEventsByTeam),
    [detail.teams, detail.scoreEventsByTeam],
  );
  const breakdown = useMemo(() => buildProblemBreakdown(detail), [detail]);
  const disruptions = useMemo(() => buildDisruptionLog(detail), [detail]);
  const generatedAt = useMemo(() => new Date().toISOString().replace("T", " ").slice(0, 16), []);

  const exportView = useMemo<EventReportExport>(
    () =>
      buildExportView({
        config,
        coverNote,
        detail,
        summary,
        scoreboard,
        breakdown,
        disruptions,
        generatedAt,
        locale,
        t,
      }),
    [
      config,
      coverNote,
      detail,
      summary,
      scoreboard,
      breakdown,
      disruptions,
      generatedAt,
      locale,
      t,
    ],
  );

  return (
    <Box>
      <div className={EVENT_REPORT_PAGE_CLASS} data-tenkacloud-print-root="true">
        <PrintControls
          eventId={detail.eventId}
          exportView={exportView}
          navigateBack={navigateBack}
          t={t}
        />
        <HeaderSection
          coverNote={coverNote}
          detail={detail}
          generatedAt={generatedAt}
          onCoverNoteChange={setCoverNote}
          t={t}
          tenantName={config.tenantName}
        />
        <SummarySection summary={summary} t={t} />
        <ScoreboardSection rows={scoreboard} t={t} />
        <ProblemBreakdownSection rows={breakdown} t={t} />
        {disruptions.length > 0 && <DisruptionSection entries={disruptions} t={t} />}
        <FooterSection generatedAt={generatedAt} t={t} />
      </div>
    </Box>
  );
}

/**
 * page state + i18n から `EventReportExport` (= exporter 入力 ViewModel) を組む。
 *
 * 「t() 解決済 label を `EventReportLabels` に詰める」 ことで exporter 側は i18n を
 * 知らずに済む (= ja / en どちらの export も同じ pure function で再現可能)。
 */
function buildExportView(args: {
  readonly config: AppConfig;
  readonly coverNote: string;
  readonly detail: EventDetail;
  readonly summary: ReturnType<typeof summarizeEvent>;
  readonly scoreboard: readonly ScoreboardRow[];
  readonly breakdown: readonly ProblemBreakdownRow[];
  readonly disruptions: readonly DisruptionEntry[];
  readonly generatedAt: string;
  readonly locale: LocaleCode;
  readonly t: Translate;
}): EventReportExport {
  const {
    config,
    coverNote,
    detail,
    summary,
    scoreboard,
    breakdown,
    disruptions,
    generatedAt,
    locale,
    t,
  } = args;
  const labels: EventReportLabels = {
    fieldOrganizer: t("event_report.field_organizer"),
    fieldEventId: t("event_report.field_event_id"),
    fieldSchedule: t("event_report.field_schedule"),
    fieldStatus: t("event_report.field_status"),
    fieldGeneratedAt: t("event_report.field_generated_at"),
    coverNoteLabel: t("event_report.cover_note_label"),
    sectionSummary: t("event_report.section_summary"),
    sectionScoreboard: t("event_report.section_scoreboard"),
    sectionProblems: t("event_report.section_problems"),
    sectionDisruptions: t("event_report.section_disruptions"),
    sectionFooter: t("event_report.section_footer"),
    statTeams: t("event_report.stat_teams"),
    statParticipants: t("event_report.stat_participants"),
    statProblems: t("event_report.stat_problems"),
    statTotalDeployments: t("event_report.stat_total_deployments"),
    statSuccessRate: t("event_report.stat_success_rate"),
    statSuccessRateBreakdown: t("event_report.stat_success_rate_breakdown", {
      ok: summary.successfulDeployments,
      failed: summary.failedDeployments,
    }),
    successRateFormatted: formatPercent(summary.successRate),
    colRank: t("event_report.col_rank"),
    colTeam: t("event_report.col_team"),
    colScore: t("event_report.col_score"),
    colProblemsSolved: t("event_report.col_problems_solved"),
    colProblemId: t("event_report.col_problem_id"),
    colRegion: t("event_report.col_region"),
    colSolvedCount: t("event_report.col_solved_count"),
    colAvgScore: t("event_report.col_avg_score"),
    colDeployments: t("event_report.col_deployments"),
    colOccurredAt: t("event_report.col_occurred_at"),
    colSource: t("event_report.col_source"),
    colPoints: t("event_report.col_points"),
    scoreboardEmpty: t("event_report.scoreboard_empty"),
    problemsEmpty: t("event_report.problems_empty"),
    disruptionsDescription: t("event_report.disruptions_description"),
    footerGeneratedBy: t("event_report.footer_generated_by"),
    footerBranding: t("event_report.footer_branding"),
  };
  return {
    locale,
    title: t("event_report.title"),
    eventName: detail.name,
    eventId: detail.eventId,
    tenantName: config.tenantName,
    scheduleRange: formatScheduleRange(detail),
    status: detail.status,
    generatedAt,
    coverNote,
    summary,
    scoreboard,
    breakdown,
    disruptions,
    labels,
  };
}

/**
 * Blob + ephemeral anchor で download をトリガー。 `URL.createObjectURL` を 1 tick 後に
 * `revokeObjectURL` して memory を返す。 SSR (= jsdom 経由を含む) で document が居ない場合は
 * no-op。
 */
function triggerBlobDownload(content: string, mimeType: string, filename: string): void {
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

function PrintControls({
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

function HeaderSection({
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

function SummarySection({
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

function ScoreboardSection({
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

function ProblemBreakdownSection({
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

function DisruptionSection({
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

function FooterSection({
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
