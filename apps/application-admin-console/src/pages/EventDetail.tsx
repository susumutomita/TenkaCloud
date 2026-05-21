import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { Navigate, useNavigate, useParams } from "react-router";
import { type ApiClient, useApiClient } from "../api/client";
import { EVENT_ID_RE, type EventDetail } from "../api/events-client";
import { DeployProgressPanel } from "../components/event-detail/DeployProgressPanel";
import { EventDangerZone } from "../components/event-detail/EventDangerZone";
import { EventHeaderActions } from "../components/event-detail/EventHeaderActions";
import { EventNotificationsPanel } from "../components/event-detail/EventNotificationsPanel";
import { EventParticipantsPanel } from "../components/event-detail/EventParticipantsPanel";
import { EventProblemSetPanel } from "../components/event-detail/EventProblemSetPanel";
import { EventSchedulePanel } from "../components/event-detail/EventSchedulePanel";
import { EventTeamsPanel } from "../components/event-detail/EventTeamsPanel";
import { EventWizardPanel } from "../components/event-detail/EventWizardPanel";
import { ScoringLockPanel } from "../components/event-detail/ScoringLockPanel";
import { TeamRankingPanel } from "../components/TeamRankingPanel";
import { TeamScoreEventsPanel } from "../components/TeamScoreEventsPanel";
import type { AppConfig } from "../config";
import { useEventDetail } from "../hooks/useEventDetail";
import { useEventOperations, validateEndsAtInput } from "../hooks/useEventOperations";
import { useT } from "../i18n";
import { computeEventWizardState, type WizardState } from "../lib/event-wizard";

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

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const t = useT();
  const apiClient = useApiClient(config);
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
    detail,
    eventId: eventIdForOperations,
    refresh,
    setError,
    t,
  });

  if (!eventIdValid || !eventId) {
    return <Navigate to="/events" replace />;
  }

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("event_detail.loading_spinner")}
      </Box>
    );
  }

  if (!detail) {
    return (
      <EventDetailErrorOnly
        apiClient={apiClient}
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
  error,
  eventId,
  navigateBack,
  operations,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly error: string | null;
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
            completeCount={0}
            detail={null}
            endInFlight={operations.endInFlight}
            failedCount={0}
            onBack={navigateBack}
            onBulkDeploy={(body) => void operations.handleBulkDeploy(body)}
            onEnd={() => operations.setConfirmEnd(true)}
            onLockScoring={() => void operations.handleLockScoring()}
            onTeardown={() => operations.setConfirmTeardown(true)}
            onUnlockScoring={() => void operations.handleUnlockScoring()}
            scoringLockInFlight={operations.scoringLockInFlight}
            t={t}
            wizard={null}
          />
        }
      >
        {t("event_detail.loading_title")}
      </Header>
      {error && (
        <Alert type="error" header={t("event_detail.error_header")}>
          {error}
        </Alert>
      )}
    </SpaceBetween>
  );
}

function EventDetailLoaded({
  apiClient,
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

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <EventHeaderActions
            apiClient={apiClient}
            bulkInFlight={operations.bulkInFlight}
            completeCount={counts.completeCount}
            detail={detail}
            endInFlight={operations.endInFlight}
            failedCount={counts.failedCount}
            onBack={navigateBack}
            onBulkDeploy={(body) => void operations.handleBulkDeploy(body)}
            onEnd={() => operations.setConfirmEnd(true)}
            onLockScoring={() => void operations.handleLockScoring()}
            onTeardown={() => operations.setConfirmTeardown(true)}
            onUnlockScoring={() => void operations.handleUnlockScoring()}
            scoringLockInFlight={operations.scoringLockInFlight}
            t={t}
            wizard={wizard}
          />
        }
      >
        {detail.name}
      </Header>

      <EventWizardPanel
        detail={detail}
        forceArchiveInFlight={operations.forceArchiveInFlight}
        onForceArchive={() => operations.setConfirmForceArchive(true)}
        t={t}
        wizard={wizard}
      />

      {error && (
        <Alert type="error" header={t("event_detail.error_header")}>
          {error}
        </Alert>
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

      <DeployProgressPanel
        allDoneCount={counts.allDoneCount}
        completeCount={counts.completeCount}
        failedCount={counts.failedCount}
        inFlightCount={counts.inFlightCount}
        manualRefreshInFlight={manualRefreshInFlight}
        onManualRefresh={() => void manualRefresh()}
        t={t}
        totalDeployCount={counts.totalDeployCount}
      />

      <ScoringLockPanel detail={detail} t={t} />

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

      <EventNotificationsPanel
        detail={detail}
        onOpen={() => operations.setNotifyModalOpen(true)}
        t={t}
      />

      <EventProblemSetPanel detail={detail} t={t} />

      {detail?.scoreEventsByTeam && <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} />}
      {detail?.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}

      <EventParticipantsPanel config={config} detail={detail} t={t} />
      <EventTeamsPanel detail={detail} t={t} />

      <EventDangerZone
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
        onScheduleEnd={() => void operations.handleScheduleEnd()}
        onScheduledStart={() => void operations.handleScheduledStart()}
        scheduleDate={operations.scheduleDate}
        scheduleInFlight={operations.scheduleInFlight}
        scheduleModalOpen={operations.scheduleModalOpen}
        scheduleTime={operations.scheduleTime}
        setEndsAtDate={operations.setEndsAtDate}
        setEndsAtTime={operations.setEndsAtTime}
        setScheduleDate={operations.setScheduleDate}
        setScheduleTime={operations.setScheduleTime}
        t={t}
      />
    </SpaceBetween>
  );
}
