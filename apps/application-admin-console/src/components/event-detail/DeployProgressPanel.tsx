import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

interface DeployStatus {
  readonly type: "error" | "in-progress" | "success";
  readonly label: string;
  readonly description: string;
}

/** After the event ends, "ready to start" and "retry failed" no longer apply. */
function computeDeployStatus(
  t: Translate,
  counts: {
    readonly allDoneCount: number;
    readonly ended: boolean;
    readonly failedCount: number;
    readonly inFlightCount: number;
    readonly totalDeployCount: number;
  },
): DeployStatus {
  const { allDoneCount, ended, failedCount, inFlightCount, totalDeployCount } = counts;
  if (inFlightCount > 0) {
    return {
      type: failedCount > 0 ? "error" : "in-progress",
      label: t("event_detail.deploy_progress_in_flight", {
        done: allDoneCount,
        total: totalDeployCount,
      }),
      description: t("event_detail.deploy_progress_in_flight_description"),
    };
  }
  if (failedCount > 0) {
    return {
      type: "error",
      label: t("event_detail.deploy_progress_complete_with_failed", { failed: failedCount }),
      description: t(
        ended
          ? "event_detail.deploy_progress_failed_description_ended"
          : "event_detail.deploy_progress_failed_description",
        { failed: failedCount },
      ),
    };
  }
  return {
    type: "success",
    label: t("event_detail.deploy_progress_complete"),
    description: t(
      ended
        ? "event_detail.deploy_progress_complete_description_ended"
        : "event_detail.deploy_progress_complete_description",
    ),
  };
}

/**
 * Event の deployment 群の進捗パネル。 進捗は status の counts (完了 / 進行中 / 失敗) で
 * 表現し、 % プログレスバーは持たない (= 状態ベースの per-deployment weight 平均は
 * teardown 中も 80% など misleading な値を出すため)。 ユーザーが知りたいのは
 * 「 何件中 何件が動いているか」 + 「 数分かかる非同期処理だよ」 という事実だけ。
 */
export function DeployProgressPanel({
  allDoneCount,
  completeCount,
  ended,
  failedCount,
  inFlightCount,
  manualRefreshInFlight,
  onManualRefresh,
  t,
  totalDeployCount,
}: {
  readonly allDoneCount: number;
  readonly completeCount: number;
  /** The event has ended: an explicit terminal status, or READY past its reserved end time. */
  readonly ended: boolean;
  readonly failedCount: number;
  readonly inFlightCount: number;
  readonly manualRefreshInFlight: boolean;
  readonly onManualRefresh: () => void;
  readonly t: Translate;
  readonly totalDeployCount: number;
}) {
  if (totalDeployCount <= 0) return null;
  const {
    type: status,
    label: statusLabel,
    description: statusDescription,
  } = computeDeployStatus(t, {
    allDoneCount,
    ended,
    failedCount,
    inFlightCount,
    totalDeployCount,
  });
  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            failedCount > 0
              ? t("event_detail.deploy_progress_description_with_failed", {
                  total: totalDeployCount,
                  complete: completeCount,
                  inFlight: inFlightCount,
                  failed: failedCount,
                })
              : t("event_detail.deploy_progress_description", {
                  total: totalDeployCount,
                  complete: completeCount,
                  inFlight: inFlightCount,
                })
          }
          actions={
            <Button
              iconName="refresh"
              loading={manualRefreshInFlight}
              onClick={onManualRefresh}
              ariaLabel={t("event_detail.deploy_progress_reload_aria")}
              data-testid="deploy-status-reload"
            >
              {t("event_detail.deploy_progress_reload")}
            </Button>
          }
        >
          {t("event_detail.deploy_progress_header")}
        </Header>
      }
    >
      <SpaceBetween size="xs">
        <StatusIndicator type={status}>{statusLabel}</StatusIndicator>
        <Box variant="small" color="text-body-secondary">
          {statusDescription}
        </Box>
        {inFlightCount > 0 && (
          <Box variant="small" color="text-status-info">
            auto polling
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
