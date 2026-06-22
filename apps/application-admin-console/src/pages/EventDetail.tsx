import Alert from "@cloudscape-design/components/alert";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Tabs from "@cloudscape-design/components/tabs";
import { ErrorState, LoadingState } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { type ApiClient, canMutateTenant, useApiClient } from "../api/client";
import { EVENT_ID_RE, type EventDetail } from "../api/events-client";
import { EventDangerZone } from "../components/event-detail/EventDangerZone";
import { EventHeaderActions } from "../components/event-detail/EventHeaderActions";
import type { AppConfig } from "../config";
import { useEventDetail } from "../hooks/useEventDetail";
import { useEventOperations, validateEndsAtInput } from "../hooks/useEventOperations";
import { useT } from "../i18n";
import { computeEventWizardState, type WizardState } from "../lib/event-wizard";
import {
  DisruptionsTab,
  EVENT_TAB_IDS,
  type EventTabId,
  NotificationsTab,
  OperationsTab,
  OverviewTab,
  ProblemsTab,
  readTabFromHash,
  ScheduleTab,
  ScoreboardTab,
  TeamsTab,
} from "./event-detail/tabs";

type EventOperations = ReturnType<typeof useEventOperations>;
type Translate = ReturnType<typeof useT>;

interface DeploymentCounts {
  readonly allDoneCount: number;
  readonly completeCount: number;
  readonly failedCount: number;
  readonly inFlightCount: number;
  readonly totalDeployCount: number;
}

function summarizeDeployments(detail: EventDetail): DeploymentCounts {
  const counts = Object.values(detail.deploymentsByProblem).reduce(
    (acc, list) => {
      for (const deployment of list) {
        acc.totalDeployCount += 1;
        if (deployment.status === "COMPLETE" || deployment.status === "AUTO_DELETED") {
          acc.completeCount += 1;
        }
        if (deployment.status === "FAILED" || deployment.status === "EXPIRED") acc.failedCount += 1;
        if (
          deployment.status === "PENDING" ||
          deployment.status === "IN_PROGRESS" ||
          deployment.status === "DELETING"
        ) {
          acc.inFlightCount += 1;
        }
      }
      return acc;
    },
    { completeCount: 0, failedCount: 0, inFlightCount: 0, totalDeployCount: 0 },
  );
  return {
    ...counts,
    allDoneCount: counts.completeCount + counts.failedCount,
  };
}

/**
 * Issue #1318: URL fragment (`#tab=<id>`) と active tab state を同期させる hook。
 *
 * - 初回 mount 時に hash から初期 tab を読む (= deep-link)
 * - tab 切替時に hash を更新 (= shareable URL)
 * - ブラウザの 戻る/進む (`hashchange`) で tab が追従する
 *
 * `history.replaceState` で hash を更新するため history entry は増えない (= 戻るボタンが
 * 1 click で list に戻る挙動を維持)。
 */
function useTabFragmentSync(): readonly [EventTabId, (next: EventTabId) => void] {
  const [activeTab, setActiveTab] = useState<EventTabId>(() => {
    // SSR guard: window は browser / test env では常に定義済みなので不到達。
    /* v8 ignore next */
    if (typeof window === "undefined") return "overview";
    return readTabFromHash(window.location.hash);
  });

  useEffect(() => {
    // SSR guard: 同上 (不到達)。
    /* v8 ignore next */
    if (typeof window === "undefined") return;
    const onHashChange = () => setActiveTab(readTabFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setTab = useCallback((next: EventTabId) => {
    setActiveTab(next);
    // SSR guard: 同上 (不到達)。
    /* v8 ignore next */
    if (typeof window === "undefined") return;
    // pathname + search を維持しつつ hash だけ書き換え。 overview は default なので hash を消す。
    const base = `${window.location.pathname}${window.location.search}`;
    const target = next === "overview" ? base : `${base}#tab=${next}`;
    window.history.replaceState(null, "", target);
  }, []);

  return [activeTab, setTab];
}

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const t = useT();
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const eventIdValid = !!eventId && EVENT_ID_RE.test(eventId);
  const eventIdForOperations = eventId ?? "";

  const { detail, error, manualRefresh, manualRefreshInFlight, refresh, setError } = useEventDetail(
    {
      apiClient,
      eventId,
      eventIdValid,
    },
  );
  const operations = useEventOperations({
    apiClient,
    canMutateTenant: canMutate,
    detail,
    eventId: eventIdForOperations,
    refresh,
    setError,
    t,
  });

  if (!eventIdValid || !eventId) {
    return <Navigate to="/events" replace />;
  }

  if (!detail) {
    // detail 未取得時は loading (error なし) と error-only (取得失敗) の 2 経路に分かれる。
    // ここで分岐すると error が string に narrow され、 error-only 側の冗長な guard が消える。
    if (!error) {
      // Issue #1366: 共有 LoadingState に切替 (DESIGN-SYSTEM 10 章)。
      return <LoadingState label={t("event_detail.loading_spinner")} />;
    }
    return (
      <EventDetailErrorOnly
        apiClient={apiClient}
        canMutateTenant={canMutate}
        error={error}
        eventId={eventId}
        navigateBack={() => navigate("/events")}
        operations={operations}
        t={t}
      />
    );
  }

  const wizard = computeEventWizardState(detail, Date.now());

  return (
    <EventDetailLoaded
      apiClient={apiClient}
      canMutateTenant={canMutate}
      config={config}
      detail={detail}
      error={error}
      eventId={eventId}
      manualRefresh={() => void manualRefresh()}
      manualRefreshInFlight={manualRefreshInFlight}
      navigateBack={() => navigate("/events")}
      operations={operations}
      t={t}
      wizard={wizard}
    />
  );
}

function EventDetailErrorOnly({
  apiClient,
  canMutateTenant,
  error,
  eventId,
  navigateBack,
  operations,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  // error は呼び出し元 (EventDetailPage) で truthy に narrow 済み (loading 経路は分岐済み)。
  readonly error: string;
  readonly eventId: string;
  readonly navigateBack: () => void;
  readonly operations: EventOperations;
  readonly t: Translate;
}) {
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <EventHeaderActions
            apiClient={apiClient}
            bulkInFlight={operations.bulkInFlight}
            canMutateTenant={canMutateTenant}
            completeCount={0}
            detail={null}
            endInFlight={operations.endInFlight}
            failedCount={0}
            onBack={navigateBack}
            onBulkDeploy={(body) => void operations.handleBulkDeploy(body)}
            onEnd={() => operations.setConfirmEnd(true)}
            onLockScoring={() => void operations.handleLockScoring()}
            onUnlockScoring={() => void operations.handleUnlockScoring()}
            scoringLockInFlight={operations.scoringLockInFlight}
            t={t}
            totalDeployCount={0}
            wizard={null}
          />
        }
      >
        {t("event_detail.loading_title")}
      </Header>
      {/* Issue #1366: error-only branch (= detail 取得失敗) を共有 ErrorState に統一。 */}
      <ErrorState title={t("event_detail.error_header")} hint={error} />
    </SpaceBetween>
  );
}

/**
 * Issue #1318: tab 一覧を組み立てて Cloudscape `Tabs` に渡す。
 *
 * 7 tabs の content は `event-detail/tabs.tsx` に切り出した tab component に委譲。
 * このページ component は composition (= 配線) だけに留め、 1 ファイル肥大化を防ぐ。
 */
function renderTabs({
  apiClient,
  canMutateTenant,
  config,
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  operations,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly config: AppConfig;
  readonly counts: DeploymentCounts;
  readonly detail: EventDetail;
  readonly manualRefresh: () => void;
  readonly manualRefreshInFlight: boolean;
  readonly operations: EventOperations;
  readonly t: Translate;
  readonly wizard: WizardState;
}) {
  const props = {
    apiClient,
    canMutateTenant,
    config,
    counts,
    detail,
    manualRefresh,
    manualRefreshInFlight,
    operations,
    t,
    wizard,
  };
  // EVENT_TAB_IDS の順序は workflow 順 (Overview → Schedule → ...) と同一。
  const contentByTab = {
    overview: <OverviewTab {...props} />,
    schedule: <ScheduleTab {...props} />,
    problems: <ProblemsTab {...props} />,
    teams: <TeamsTab {...props} />,
    scoreboard: <ScoreboardTab {...props} />,
    notifications: <NotificationsTab {...props} />,
    operations: <OperationsTab {...props} />,
    disruptions: <DisruptionsTab {...props} />,
  } as const;
  // The red-team Disruptions tab is feature-flagged (config.features.redTeam) — hidden until the
  // cross-account executor is verified live, so operators don't fire into an unproven path.
  return EVENT_TAB_IDS.filter((id) => id !== "disruptions" || config.features?.redTeam).map(
    (id) => ({
      id,
      label: t(`event_detail.tab_${id}`),
      content: <SpaceBetween size="l">{contentByTab[id]}</SpaceBetween>,
    }),
  );
}

function EventDetailLoaded({
  apiClient,
  canMutateTenant,
  config,
  detail,
  error,
  eventId,
  manualRefresh,
  manualRefreshInFlight,
  navigateBack,
  operations,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly config: AppConfig;
  readonly detail: EventDetail;
  readonly error: string | null;
  readonly eventId: string;
  readonly manualRefresh: () => void;
  readonly manualRefreshInFlight: boolean;
  readonly navigateBack: () => void;
  readonly operations: EventOperations;
  readonly t: Translate;
  readonly wizard: WizardState;
}) {
  const counts = summarizeDeployments(detail);
  const endsAtValidation = validateEndsAtInput(
    operations.endsAtDate,
    operations.endsAtTime,
    detail.startsAt,
    Date.now(),
  );
  const endsAtErrorText = endsAtValidation.errorKey ? t(endsAtValidation.errorKey) : undefined;
  const endsAtInvalid = endsAtErrorText !== undefined;
  const [activeTab, setActiveTab] = useTabFragmentSync();

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <EventHeaderActions
            apiClient={apiClient}
            bulkInFlight={operations.bulkInFlight}
            canMutateTenant={canMutateTenant}
            completeCount={counts.completeCount}
            detail={detail}
            endInFlight={operations.endInFlight}
            failedCount={counts.failedCount}
            onBack={navigateBack}
            onBulkDeploy={(body) => void operations.handleBulkDeploy(body)}
            onEnd={() => operations.setConfirmEnd(true)}
            onLockScoring={() => void operations.handleLockScoring()}
            onUnlockScoring={() => void operations.handleUnlockScoring()}
            scoringLockInFlight={operations.scoringLockInFlight}
            t={t}
            totalDeployCount={counts.totalDeployCount}
            wizard={wizard}
          />
        }
      >
        {detail.name}
      </Header>

      {error && (
        // Issue #1366: detail は取得済 (= 表示は壊さない) で、 個別 operation の失敗を error
        // として alert する用途。 dismiss を付けて user が閉じられるようにする。
        <ErrorState title={t("event_detail.error_header")} hint={error} />
      )}
      {operations.bulkResult && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => operations.setBulkResult(null)}
          header={t("event_detail.bulk_result_header")}
        >
          {t("event_detail.bulk_result_body", {
            enqueued: operations.bulkResult.enqueued,
            skipped: operations.bulkResult.skipped,
          })}
        </Alert>
      )}

      <Tabs
        activeTabId={activeTab}
        onChange={({ detail: d }) => {
          // Cloudscape の TabChangeDetail.activeTabId は string。 既知 id にのみ反映。
          const next = d.activeTabId;
          if (next === "overview" || EVENT_TAB_IDS.includes(next as EventTabId)) {
            setActiveTab(next as EventTabId);
          }
        }}
        tabs={renderTabs({
          apiClient,
          canMutateTenant,
          config,
          counts,
          detail,
          manualRefresh,
          manualRefreshInFlight,
          operations,
          t,
          wizard,
        })}
      />

      <EventDangerZone
        canMutateTenant={canMutateTenant}
        config={config}
        confirmEnd={operations.confirmEnd}
        confirmForceArchive={operations.confirmForceArchive}
        confirmTeardown={operations.confirmTeardown}
        detail={detail}
        endsAtDate={operations.endsAtDate}
        endsAtErrorText={endsAtErrorText}
        endsAtInFlight={operations.endsAtInFlight}
        endsAtInvalid={endsAtInvalid}
        endsAtModalOpen={operations.endsAtModalOpen}
        endsAtTime={operations.endsAtTime}
        endsAtValidation={endsAtValidation}
        eventId={eventId}
        forceArchiveInFlight={operations.forceArchiveInFlight}
        notifyJustSent={operations.notifyJustSent}
        notifyModalOpen={operations.notifyModalOpen}
        onBulkTeardown={() => void operations.handleBulkTeardown()}
        onDismissEnd={() => operations.setConfirmEnd(false)}
        onDismissEndsAt={() => operations.setEndsAtModalOpen(false)}
        onDismissForceArchive={() => operations.setConfirmForceArchive(false)}
        onDismissNotification={() => operations.setNotifyModalOpen(false)}
        onDismissNotificationSuccess={() => operations.setNotifyJustSent(false)}
        onDismissSchedule={() => operations.setScheduleModalOpen(false)}
        onDismissTeardown={() => operations.setConfirmTeardown(false)}
        onEndEvent={() => void operations.handleEndEvent()}
        onForceArchive={() => void operations.handleForceArchive()}
        onNotificationSuccess={() => {
          operations.setNotifyModalOpen(false);
          operations.setNotifyJustSent(true);
        }}
        onDismissTeardownSchedule={() => operations.setTeardownModalOpen(false)}
        onScheduleEnd={() => void operations.handleScheduleEnd()}
        onScheduleTeardown={() => void operations.handleScheduleTeardown()}
        onScheduledStart={() => void operations.handleScheduledStart()}
        scheduleDate={operations.scheduleDate}
        scheduleInFlight={operations.scheduleInFlight}
        scheduleModalOpen={operations.scheduleModalOpen}
        scheduleTime={operations.scheduleTime}
        setEndsAtDate={operations.setEndsAtDate}
        setEndsAtTime={operations.setEndsAtTime}
        setScheduleDate={operations.setScheduleDate}
        setScheduleTime={operations.setScheduleTime}
        setTeardownDate={operations.setTeardownDate}
        setTeardownTime={operations.setTeardownTime}
        teardownDate={operations.teardownDate}
        teardownInFlight={operations.teardownInFlight}
        teardownModalOpen={operations.teardownModalOpen}
        teardownTime={operations.teardownTime}
        t={t}
      />
    </SpaceBetween>
  );
}
