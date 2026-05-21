import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Event の deployment 群の進捗パネル。 進捗は status の counts (完了 / 進行中 / 失敗) で
 * 表現し、 % プログレスバーは持たない (= 状態ベースの per-deployment weight 平均は
 * teardown 中も 80% など misleading な値を出すため)。 ユーザーが知りたいのは
 * 「 何件中 何件が動いているか」 + 「 数分かかる非同期処理だよ」 という事実だけ。
 */
export function DeployProgressPanel({
  allDoneCount,
  completeCount,
  failedCount,
  inFlightCount,
  manualRefreshInFlight,
  onManualRefresh,
  t,
  totalDeployCount,
}: {
  readonly allDoneCount: number;
  readonly completeCount: number;
  readonly failedCount: number;
  readonly inFlightCount: number;
  readonly manualRefreshInFlight: boolean;
  readonly onManualRefresh: () => void;
  readonly t: Translate;
  readonly totalDeployCount: number;
}) {
  if (totalDeployCount <= 0) return null;
  const status =
    failedCount > 0
      ? ("error" as const)
      : inFlightCount > 0
        ? ("in-progress" as const)
        : ("success" as const);
  const statusLabel =
    inFlightCount > 0
      ? t("event_detail.deploy_progress_in_flight", {
          done: allDoneCount,
          total: totalDeployCount,
        })
      : failedCount > 0
        ? t("event_detail.deploy_progress_complete_with_failed", { failed: failedCount })
        : t("event_detail.deploy_progress_complete");
  const statusDescription =
    inFlightCount > 0
      ? t("event_detail.deploy_progress_in_flight_description")
      : failedCount > 0
        ? t("event_detail.deploy_progress_failed_description")
        : t("event_detail.deploy_progress_complete_description");
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
