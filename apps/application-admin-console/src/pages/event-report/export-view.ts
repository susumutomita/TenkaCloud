/**
 * page state + i18n から `EventReportExport` (= exporter 入力 ViewModel) を組む。
 *
 * 「t() 解決済 label を `EventReportLabels` に詰める」 ことで exporter 側は i18n を
 * 知らずに済む (= ja / en どちらの export も同じ pure function で再現可能)。 page
 * (React) と exporter (pure) の間の境界 ViewModel を担う。
 */

import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";
import type { LocaleCode } from "../../i18n";
import {
  type DisruptionEntry,
  formatPercent,
  type ProblemBreakdownRow,
  type ScoreboardRow,
  type summarizeEvent,
} from "../../lib/event-report-stats";
import type { EventReportExport, EventReportLabels } from "./exporters/html";
import { formatScheduleRange } from "./formatters";

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function buildExportView(args: {
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
