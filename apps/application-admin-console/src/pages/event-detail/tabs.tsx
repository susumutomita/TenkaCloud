/**
 * Issue #1318: Event Detail 画面を 7 workflow tabs に再編する構造。
 *
 * 旧 UX は全 section が 1 列の縦スクロールに並び 「温泉宿状態」 (情報過密で workflow が読めない)
 * になっていた。 本ファイルは Cloudscape `Tabs` で 7 グループに切り分け、 各 tab を運営の
 * 典型 workflow 順 (Overview / Schedule / Problems / Teams / Scoreboard / Notifications / Operations)
 * に並べる。
 *
 * 機能削除はなし。 既存 panel component を tab content に振り分けるだけ。 modals 群 (EventDangerZone)
 * は tab 外 (page 直下) に残し、 どの tab からも開けるようにする。
 *
 * Tab id は URL fragment (`#tab=schedule` 等) で deep-link 可能。
 */

import type { ApiClient } from "../../api/client";
import type { EventDetail } from "../../api/events-client";
import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventNotificationsPanel } from "../../components/event-detail/EventNotificationsPanel";
import { EventParticipantsPanel } from "../../components/event-detail/EventParticipantsPanel";
import { EventProblemSetPanel } from "../../components/event-detail/EventProblemSetPanel";
import { EventSchedulePanel } from "../../components/event-detail/EventSchedulePanel";
import { EventTeamsPanel } from "../../components/event-detail/EventTeamsPanel";
import { EventRescuePanel, EventWizardPanel } from "../../components/event-detail/EventWizardPanel";
import { ScoringLockPanel } from "../../components/event-detail/ScoringLockPanel";
import { TeamRankingPanel } from "../../components/TeamRankingPanel";
import { TeamScoreEventsPanel } from "../../components/TeamScoreEventsPanel";
import type { AppConfig } from "../../config";
import type { useEventOperations } from "../../hooks/useEventOperations";
import type { useT } from "../../i18n";
import type { WizardState } from "../../lib/event-wizard";

type Translate = ReturnType<typeof useT>;
type EventOperations = ReturnType<typeof useEventOperations>;

export interface EventTabContentProps {
  readonly apiClient: ApiClient | null;
  readonly config: AppConfig;
  readonly counts: {
    readonly allDoneCount: number;
    readonly completeCount: number;
    readonly failedCount: number;
    readonly inFlightCount: number;
    readonly totalDeployCount: number;
  };
  readonly detail: EventDetail;
  readonly manualRefresh: () => void;
  readonly manualRefreshInFlight: boolean;
  readonly operations: EventOperations;
  readonly t: Translate;
  readonly wizard: WizardState;
}

export const EVENT_TAB_IDS = [
  "overview",
  "schedule",
  "problems",
  "teams",
  "scoreboard",
  "notifications",
  "operations",
] as const;

export type EventTabId = (typeof EVENT_TAB_IDS)[number];

export function isEventTabId(value: string): value is EventTabId {
  return (EVENT_TAB_IDS as readonly string[]).includes(value);
}

/**
 * URL fragment (`#tab=<id>`) から初期 active tab を読む。
 *
 * `#tab=schedule` のような形式のみ受け付け、 未指定 / 不正値は "overview" にフォールバック。
 * SSR / test 環境で `window` が無い場合も "overview" を返す (= 副作用なし)。
 */
export function readTabFromHash(hash: string): EventTabId {
  // hash は "#tab=schedule" / "#tab=schedule&foo=bar" / "" の形を想定。
  const m = hash.match(/[#&]tab=([a-z]+)/);
  if (!m) return "overview";
  const candidate = m[1];
  return isEventTabId(candidate) ? candidate : "overview";
}

export function OverviewTab({
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  t,
  wizard,
}: EventTabContentProps) {
  return (
    <>
      <EventWizardPanel t={t} wizard={wizard} />
      <ScoringLockPanel detail={detail} t={t} />
      <DeployProgressPanel
        allDoneCount={counts.allDoneCount}
        completeCount={counts.completeCount}
        failedCount={counts.failedCount}
        inFlightCount={counts.inFlightCount}
        manualRefreshInFlight={manualRefreshInFlight}
        onManualRefresh={manualRefresh}
        t={t}
        totalDeployCount={counts.totalDeployCount}
      />
    </>
  );
}

export function ScheduleTab({ apiClient, detail, operations, t, wizard }: EventTabContentProps) {
  return (
    <EventSchedulePanel
      apiClient={apiClient}
      detail={detail}
      endsAtInFlight={operations.endsAtInFlight}
      freezeMinutesInFlight={operations.freezeMinutesInFlight}
      freezeMinutesInput={operations.freezeMinutesInput}
      onEndNowSchedule={() => void operations.handleEndNowSchedule()}
      onOpenEndsAtModal={() => operations.setEndsAtModalOpen(true)}
      onOpenScheduleModal={() => operations.setScheduleModalOpen(true)}
      onSaveFreezeMinutes={() => void operations.handleSaveFreezeMinutes()}
      onStartNow={() => void operations.handleStartNow()}
      onUpdateFreezeMinutes={operations.setFreezeMinutesInput}
      scheduleInFlight={operations.scheduleInFlight}
      t={t}
      wizard={wizard}
    />
  );
}

export function ProblemsTab({ detail, t }: EventTabContentProps) {
  return <EventProblemSetPanel detail={detail} t={t} />;
}

export function TeamsTab({ config, detail, t }: EventTabContentProps) {
  return (
    <>
      <EventParticipantsPanel config={config} detail={detail} t={t} />
      <EventTeamsPanel detail={detail} t={t} />
    </>
  );
}

export function ScoreboardTab({ detail }: EventTabContentProps) {
  return (
    <>
      {detail.scoreEventsByTeam && <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} />}
      {detail.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}
    </>
  );
}

export function NotificationsTab({ detail, operations, t }: EventTabContentProps) {
  return (
    <EventNotificationsPanel
      detail={detail}
      onOpen={() => operations.setNotifyModalOpen(true)}
      t={t}
    />
  );
}

/**
 * Operations tab: 普段使わない高度操作 (rescue 系) を集約。
 *
 * 現在は TEARDOWN 時の Force ARCHIVED rescue Alert のみ。 将来的に bulk redeploy / 詳細削除 等の
 * 進阶操作を追加する予定 (issue #1318 の Out of scope ではあるが格納先として確保)。
 */
export function OperationsTab({ detail, operations, t }: EventTabContentProps) {
  return (
    <EventRescuePanel
      detail={detail}
      forceArchiveInFlight={operations.forceArchiveInFlight}
      onForceArchive={() => operations.setConfirmForceArchive(true)}
      t={t}
    />
  );
}
