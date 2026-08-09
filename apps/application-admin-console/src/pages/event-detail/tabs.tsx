/**
 * Issue #1318: Event Detail 画面を 7 workflow tabs に再編する構造。
 *
 * 旧 UX は全 section が 1 列の縦スクロールに並び 「温泉宿状態」 (情報過密で workflow が読めない)
 * になっていた。 本ファイルは Cloudscape `Tabs` で 7 グループに切り分け、 各 tab を運営の
 * 典型 workflow 順 (Overview / Schedule / Problems / Teams / Scoreboard / Notifications / Operations)
 * に並べる。
 *
 * 各 tab content は独立した module。 重量級の 2 tab (Overview / Operations — 複数 panel + JSX)
 * は専用ファイルに分離し (`./OverviewTab` / `./OperationsTab`)、 残り 5 tab は単一 / 二重 panel の
 * 薄い wrapper なのでここに同居させる。 共有 prop 契約は `./tab-content-props`。 これにより各
 * module は自分が描画する panel だけに依存する (= 旧 24-import 集約の解消)。
 *
 * Tab id は URL fragment (`#tab=schedule` 等) で deep-link 可能。
 */

import { EventNotificationsPanel } from "../../components/event-detail/EventNotificationsPanel";
import { EventParticipantsPanel } from "../../components/event-detail/EventParticipantsPanel";
import { EventProblemSetPanel } from "../../components/event-detail/EventProblemSetPanel";
import { EventProgressionGatePanel } from "../../components/event-detail/EventProgressionGatePanel";
import { EventSchedulePanel } from "../../components/event-detail/EventSchedulePanel";
import { EventTeamsPanel } from "../../components/event-detail/EventTeamsPanel";
import { TeamRankingPanel } from "../../components/TeamRankingPanel";
import { TeamScoreEventsPanel } from "../../components/TeamScoreEventsPanel";
import { DisruptionsPanel } from "./DisruptionsPanel";
import type { EventTabContentProps } from "./tab-content-props";

export { OperationsTab } from "./OperationsTab";
export { OverviewTab } from "./OverviewTab";
export type { EventTabContentProps } from "./tab-content-props";

export const EVENT_TAB_IDS = [
  "overview",
  "schedule",
  "problems",
  "teams",
  "scoreboard",
  "notifications",
  "operations",
  // [#1417/#1666] feature-flagged (redTeam): the tab only renders when config.features.redTeam.
  "disruptions",
  // [#2283] Advanced な競技ルール (Progression Gate)。 tab は常時表示し、 panel 側が
  // per-tenant runtime flag (challengePrerequisiteGate) で編集可否を切り替える。
  "gate",
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

export function ScheduleTab({
  apiClient,
  canMutateTenant,
  counts,
  detail,
  operations,
  t,
  wizard,
}: EventTabContentProps) {
  return (
    <EventSchedulePanel
      apiClient={apiClient}
      bulkInFlight={operations.bulkInFlight}
      canMutateTenant={canMutateTenant}
      completeCount={counts.completeCount}
      deployScheduleInFlight={operations.deployScheduleInFlight}
      detail={detail}
      endsAtInFlight={operations.endsAtInFlight}
      freezeMinutesInFlight={operations.freezeMinutesInFlight}
      freezeMinutesInput={operations.freezeMinutesInput}
      onBulkDeploy={(b) => void operations.handleBulkDeploy(b)}
      onConfirmTeardown={() => operations.setConfirmTeardown(true)}
      onEndNowSchedule={() => void operations.handleEndNowSchedule()}
      onOpenDeployModal={() => operations.setDeployScheduleModalOpen(true)}
      onOpenEndsAtModal={() => operations.setEndsAtModalOpen(true)}
      onOpenScheduleModal={() => operations.setScheduleModalOpen(true)}
      onOpenTeardownModal={() => operations.setTeardownModalOpen(true)}
      onSaveFreezeMinutes={() => void operations.handleSaveFreezeMinutes()}
      onStartNow={() => void operations.handleStartNow()}
      onUpdateFreezeMinutes={operations.setFreezeMinutesInput}
      scheduleInFlight={operations.scheduleInFlight}
      teardownInFlight={operations.teardownInFlight}
      totalDeployCount={counts.totalDeployCount}
      t={t}
      wizard={wizard}
    />
  );
}

export function ProblemsTab({ detail, t }: EventTabContentProps) {
  return <EventProblemSetPanel detail={detail} t={t} />;
}

export function TeamsTab({
  apiClient,
  canMutateTenant,
  config,
  detail,
  manualRefresh,
  t,
}: EventTabContentProps) {
  return (
    <>
      <EventParticipantsPanel config={config} detail={detail} t={t} />
      <EventTeamsPanel
        apiClient={apiClient}
        canMutateTenant={canMutateTenant}
        detail={detail}
        onRefresh={manualRefresh}
        t={t}
      />
    </>
  );
}

export function ScoreboardTab({ detail }: EventTabContentProps) {
  return (
    <>
      {detail.scoreEventsByTeam && (
        <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} startsAt={detail.startsAt} />
      )}
      {detail.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}
    </>
  );
}

export function NotificationsTab({ canMutateTenant, detail, operations, t }: EventTabContentProps) {
  return (
    <EventNotificationsPanel
      canMutateTenant={canMutateTenant}
      detail={detail}
      onOpen={() => operations.setNotifyModalOpen(true)}
      t={t}
    />
  );
}

export function DisruptionsTab({ apiClient, canMutateTenant, detail, t }: EventTabContentProps) {
  return (
    <DisruptionsPanel
      apiClient={apiClient}
      canMutateTenant={canMutateTenant}
      detail={detail}
      t={t}
    />
  );
}

// [#2283] Progression / Gate (Advanced) tab。 保存成功 / 除去成功時に manualRefresh で
// detail を取り直す (= progressionGate の反映)。
export function GateTab({
  apiClient,
  canMutateTenant,
  detail,
  manualRefresh,
  t,
}: EventTabContentProps) {
  return (
    <EventProgressionGatePanel
      apiClient={apiClient}
      canMutateTenant={canMutateTenant}
      detail={detail}
      onRefresh={manualRefresh}
      t={t}
    />
  );
}
