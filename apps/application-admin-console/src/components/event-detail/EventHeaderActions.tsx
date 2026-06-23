import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import type { ApiClient } from "../../api/client";
import type { BulkDeployBody, EventDetail } from "../../api/events-client";
import { isTerminalEventStatus } from "../../lib/effective-event-status";
import { isReportReady } from "../../lib/event-report-stats";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventHeaderActions({
  apiClient,
  bulkInFlight,
  canMutateTenant,
  detail,
  endInFlight,
  failedCount,
  onBack,
  onBulkDeploy,
  onEnd,
  onLockScoring,
  onUnlockScoring,
  scoringLockInFlight,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly bulkInFlight: "deploy" | "teardown" | "retry-failed" | "redeploy" | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail | null;
  readonly endInFlight: boolean;
  readonly failedCount: number;
  readonly onBack: () => void;
  readonly onBulkDeploy: (body?: BulkDeployBody) => void;
  readonly onEnd: () => void;
  readonly onLockScoring: () => void;
  readonly onUnlockScoring: () => void;
  readonly scoringLockInFlight: "lock" | "unlock" | null;
  readonly t: Translate;
}) {
  const navigate = useNavigate();
  // Deploy / teardown のライフサイクル操作は「スケジュール」tab に集約 (= header から重複を撤去)。
  // header に残すのは back / 失敗分の再実行 / 終了 / 採点ロック / レポートの軽量な操作のみ。
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <Button onClick={onBack}>{t("event_detail.back_to_list")}</Button>
      {failedCount > 0 && (
        <Button
          loading={bulkInFlight === "retry-failed"}
          disabled={
            !detail ||
            !canMutateTenant ||
            isTerminalEventStatus(detail.status) ||
            bulkInFlight !== null
          }
          iconName="refresh"
          onClick={() => onBulkDeploy({ retryFailedOnly: true })}
        >
          {t("event_detail.retry_failed", { count: failedCount })}
        </Button>
      )}
      <Button
        loading={endInFlight}
        disabled={!detail || !canMutateTenant || detail.status !== "READY"}
        onClick={onEnd}
      >
        {t("event_detail.end_event")}
      </Button>
      {detail && (detail.status === "READY" || detail.status === "ENDED") && (
        <Button
          loading={scoringLockInFlight !== null}
          disabled={!apiClient || !canMutateTenant}
          onClick={detail.scoringLocked === true ? onUnlockScoring : onLockScoring}
        >
          {detail.scoringLocked === true
            ? t("event_detail.scoring_unlock")
            : t("event_detail.scoring_lock")}
        </Button>
      )}
      {/* Issue: header の "Delete" (実体は teardown) は削除。 破壊的な teardown は
        「スケジュール」 tab の「即座に撤去」に 1 箇所だけ置く (= header とタブで重複させない)。 */}
      {isReportReady(detail) && detail && (
        <Button iconName="file" onClick={() => navigate(`/events/${detail.eventId}/report`)}>
          {t("event_detail.print_report")}
        </Button>
      )}
    </SpaceBetween>
  );
}
