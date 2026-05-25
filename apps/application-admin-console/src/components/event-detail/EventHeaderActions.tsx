import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import type { ApiClient } from "../../api/client";
import type { BulkDeployBody, EventDetail } from "../../api/events-client";
import { isReportReady } from "../../lib/event-report-stats";
import type { WizardState } from "../../lib/event-wizard";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventHeaderActions({
  apiClient,
  bulkInFlight,
  completeCount,
  detail,
  endInFlight,
  failedCount,
  onBack,
  onBulkDeploy,
  onEnd,
  onLockScoring,
  onTeardown,
  onUnlockScoring,
  scoringLockInFlight,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly bulkInFlight: "deploy" | "teardown" | "retry-failed" | "redeploy" | null;
  readonly completeCount: number;
  readonly detail: EventDetail | null;
  readonly endInFlight: boolean;
  readonly failedCount: number;
  readonly onBack: () => void;
  readonly onBulkDeploy: (body?: BulkDeployBody) => void;
  readonly onEnd: () => void;
  readonly onLockScoring: () => void;
  readonly onTeardown: () => void;
  readonly onUnlockScoring: () => void;
  readonly scoringLockInFlight: "lock" | "unlock" | null;
  readonly t: Translate;
  readonly wizard: WizardState | null;
}) {
  const navigate = useNavigate();
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <Button onClick={onBack}>{t("event_detail.back_to_list")}</Button>
      <Button
        variant={wizard?.primary === "deploy" ? "primary" : "normal"}
        loading={bulkInFlight === "deploy"}
        disabled={
          !detail ||
          detail.problems.length === 0 ||
          detail.teams.length === 0 ||
          detail.status === "ENDED" ||
          detail.status === "TEARDOWN" ||
          detail.status === "ARCHIVED"
        }
        onClick={() => onBulkDeploy()}
      >
        {t("event_detail.deploy_button")}
      </Button>
      {failedCount > 0 && (
        <Button
          loading={bulkInFlight === "retry-failed"}
          disabled={
            !detail ||
            detail.status === "ENDED" ||
            detail.status === "TEARDOWN" ||
            detail.status === "ARCHIVED" ||
            bulkInFlight !== null
          }
          iconName="refresh"
          onClick={() => onBulkDeploy({ retryFailedOnly: true })}
        >
          {t("event_detail.retry_failed", { count: failedCount })}
        </Button>
      )}
      {completeCount > 0 && (
        <Button
          loading={bulkInFlight === "redeploy"}
          disabled={
            !detail ||
            detail.status === "ENDED" ||
            detail.status === "TEARDOWN" ||
            detail.status === "ARCHIVED" ||
            bulkInFlight !== null
          }
          iconName="refresh"
          onClick={() => onBulkDeploy({ forceRedeploy: true })}
        >
          {t("event_detail.redeploy", { count: completeCount })}
        </Button>
      )}
      <Button loading={endInFlight} disabled={!detail || detail.status !== "READY"} onClick={onEnd}>
        {t("event_detail.end_event")}
      </Button>
      {detail && (detail.status === "READY" || detail.status === "ENDED") && (
        <Button
          loading={scoringLockInFlight !== null}
          disabled={!apiClient}
          onClick={detail.scoringLocked === true ? onUnlockScoring : onLockScoring}
        >
          {detail.scoringLocked === true
            ? t("event_detail.scoring_unlock")
            : t("event_detail.scoring_lock")}
        </Button>
      )}
      <Button
        variant={wizard?.primary === "delete" ? "primary" : "normal"}
        loading={bulkInFlight === "teardown"}
        disabled={!detail}
        onClick={onTeardown}
      >
        {t("event_detail.delete_button")}
      </Button>
      {isReportReady(detail) && detail && (
        <Button iconName="file" onClick={() => navigate(`/events/${detail.eventId}/report`)}>
          {t("event_detail.print_report")}
        </Button>
      )}
    </SpaceBetween>
  );
}
