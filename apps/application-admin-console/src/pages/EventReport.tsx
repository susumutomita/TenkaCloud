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
 *     `event-report/use-print-stylesheet.ts`。
 *   - **無依存 PDF**: bundle size を抑えるため PDF 生成 library は入れず browser native
 *     の Print Preview に任せる。 print 中の chrome (= TopNav / SideNav / 「印刷」 button)
 *     は `data-tenkacloud-print-no-print` で hide。
 *   - **cover note**: operator が自由記入できる intro paragraph。 component state で
 *     保持 (= サーバ永続化はしない; 印刷直前に書いて出すだけ)。
 *   - **責務分割 (#986)**: 本 file は data 取得 / state / ViewModel 組み立ての orchestrator。
 *     表示は `event-report/sections.tsx`、 ViewModel は `event-report/export-view.ts`、
 *     formatter / print hook / download は同 subdir に分割。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import { EVENT_ID_RE, type EventDetail } from "../api/events-client";
import type { AppConfig } from "../config";
import { useEventDetail } from "../hooks/useEventDetail";
import { type LocaleCode, useI18n } from "../i18n";
import {
  buildDisruptionLog,
  buildProblemBreakdown,
  buildScoreboard,
  summarizeEvent,
} from "../lib/event-report-stats";
import { buildExportView, type Translate } from "./event-report/export-view";
import { EVENT_REPORT_PAGE_CLASS, type EventReportExport } from "./event-report/exporters/html";
import {
  DisruptionSection,
  FooterSection,
  HeaderSection,
  PrintControls,
  ProblemBreakdownSection,
  ScoreboardSection,
  SummarySection,
} from "./event-report/sections";
import { usePrintStylesheet } from "./event-report/use-print-stylesheet";

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
