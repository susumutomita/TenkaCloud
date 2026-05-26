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

import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ApiClient } from "../../api/client";
import type { EventDetail } from "../../api/events-client";
import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventChecklistPanel } from "../../components/event-detail/EventChecklistPanel";
import { EventNotificationsPanel } from "../../components/event-detail/EventNotificationsPanel";
import { EventParticipantsPanel } from "../../components/event-detail/EventParticipantsPanel";
import { EventPhaseBanner } from "../../components/event-detail/EventPhaseBanner";
import { EventProblemSetPanel } from "../../components/event-detail/EventProblemSetPanel";
import { EventReadinessPanel } from "../../components/event-detail/EventReadinessPanel";
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

/**
 * Issue #1362: Qiita 「用途別グルーピング」 原則で Overview tab を 3 グループに整理。
 *
 *   1. 現状 (status)        — Event 概要 (ScoringLockPanel) + 現在のフェーズ
 *   2. 次のアクション (hero) — operator が押すべき button (EventWizardPanel の CTA half)
 *   3. リソース / Deploy 進捗 — チーム / 問題 / deployment 進捗
 *
 * `EventWizardPanel` 内部で「現状 (phase indicator)」 と「次のアクション (CTA)」 を別
 * Container に分割している (= 上の 1+2)。 視線は 画面 title → 現状 → 次のアクション →
 * リソース の順に降りていく。
 */
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
      {/* Issue #1350: Setup / Live / Teardown の phase 帯を冒頭に表示 (色 cue) */}
      <EventPhaseBanner detail={detail} t={t} />
      <ScoringLockPanel detail={detail} t={t} />
      <EventWizardPanel t={t} wizard={wizard} />
      {/* Issue #1350: 4 項目の readiness check + 全 ✓ で 「準備完了」 大 badge */}
      <EventReadinessPanel
        completeCount={counts.completeCount}
        detail={detail}
        t={t}
        totalDeployCount={counts.totalDeployCount}
      />
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
      {/* Issue #1350: T-7 / T-1 / T-0 / T+0 phase 別 operator checklist */}
      <EventChecklistPanel t={t} />
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
 * Operations tab: 普段使わない高度操作を集約する。
 *
 * Issue #1318 で 「rescue 系を Operations に集約」 と決めたが、 #1324 で実装したときに
 * EventRescuePanel (TEARDOWN 時のみ render) のみを置いてしまい、 非 TEARDOWN 状態では
 * tab が完全に空になっていた (issue #1328)。 本コミットで 4 section を常時表示するようにし、
 * status を問わず 運用 tab に内容があることを保証する。
 *
 * 表示 section:
 *  1. EventRescuePanel — 既存。 status === TEARDOWN のときだけ render
 *  2. 一括操作 — Bulk redeploy / Bulk teardown。 header にも同等 button があるが Operations tab
 *     の主目的 (= 高度操作の集約先) として明示的に重複配置する
 *  3. Deploy 進捗詳細 — DeployProgressPanel。 deployment が 0 件のときは empty hint
 *  4. Event 削除 (danger zone) — header の Delete と同じ confirmTeardown modal を開く
 */
export function OperationsTab({
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  operations,
  t,
}: EventTabContentProps) {
  const bulkDisabled =
    detail.status === "ENDED" || detail.status === "TEARDOWN" || detail.status === "ARCHIVED";
  return (
    <SpaceBetween size="l">
      <Header variant="h2">{t("event_detail.operations_header")}</Header>
      <Alert type="info" data-testid="operations-tab-intro">
        {t("event_detail.operations_intro")}
      </Alert>

      <EventRescuePanel
        detail={detail}
        forceArchiveInFlight={operations.forceArchiveInFlight}
        onForceArchive={() => operations.setConfirmForceArchive(true)}
        t={t}
      />

      <Container
        data-testid="operations-bulk-section"
        header={
          <Header variant="h3" description={t("event_detail.operations_bulk_description")}>
            {t("event_detail.operations_bulk_header")}
          </Header>
        }
      >
        <SpaceBetween size="xs" direction="horizontal">
          <Button
            data-testid="operations-bulk-deploy"
            loading={operations.bulkInFlight === "deploy"}
            disabled={
              detail.problems.length === 0 ||
              detail.teams.length === 0 ||
              bulkDisabled ||
              operations.bulkInFlight !== null
            }
            onClick={() => void operations.handleBulkDeploy()}
          >
            {t("event_detail.operations_bulk_deploy")}
          </Button>
          <Button
            data-testid="operations-bulk-teardown"
            loading={operations.bulkInFlight === "teardown"}
            disabled={operations.bulkInFlight !== null}
            onClick={() => operations.setConfirmTeardown(true)}
          >
            {t("event_detail.operations_bulk_teardown")}
          </Button>
        </SpaceBetween>
      </Container>

      <Container
        header={<Header variant="h3">{t("event_detail.operations_deploy_progress_header")}</Header>}
      >
        {counts.totalDeployCount > 0 ? (
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
        ) : (
          <Alert type="info">{t("event_detail.operations_deploy_progress_empty")}</Alert>
        )}
      </Container>

      <Container
        data-testid="operations-delete-section"
        header={
          <Header
            variant="h3"
            actions={
              <Button
                variant="primary"
                data-testid="operations-delete-button"
                loading={operations.bulkInFlight === "teardown"}
                onClick={() => operations.setConfirmTeardown(true)}
              >
                {t("event_detail.operations_delete_button")}
              </Button>
            }
          >
            {t("event_detail.operations_delete_header")}
          </Header>
        }
      >
        <Alert type="warning">{t("event_detail.operations_delete_warning")}</Alert>
      </Container>
    </SpaceBetween>
  );
}
