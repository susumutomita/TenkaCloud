import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import ProgressBar from "@cloudscape-design/components/progress-bar";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function DeployProgressPanel({
  allDoneCount,
  completeCount,
  deployProgressPercent,
  failedCount,
  inFlightCount,
  manualRefreshInFlight,
  onManualRefresh,
  t,
  totalDeployCount,
}: {
  readonly allDoneCount: number;
  readonly completeCount: number;
  readonly deployProgressPercent: number;
  readonly failedCount: number;
  readonly inFlightCount: number;
  readonly manualRefreshInFlight: boolean;
  readonly onManualRefresh: () => void;
  readonly t: Translate;
  readonly totalDeployCount: number;
}) {
  if (totalDeployCount <= 0) return null;
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
      <ProgressBar
        value={deployProgressPercent}
        label={
          inFlightCount > 0
            ? t("event_detail.deploy_progress_in_flight", {
                done: allDoneCount,
                total: totalDeployCount,
              })
            : failedCount > 0
              ? t("event_detail.deploy_progress_complete_with_failed", { failed: failedCount })
              : t("event_detail.deploy_progress_complete")
        }
        description={
          inFlightCount > 0
            ? t("event_detail.deploy_progress_in_flight_description")
            : failedCount > 0
              ? t("event_detail.deploy_progress_failed_description")
              : t("event_detail.deploy_progress_complete_description")
        }
        status={failedCount > 0 ? "error" : inFlightCount > 0 ? "in-progress" : "success"}
        additionalInfo={inFlightCount > 0 ? "auto polling" : undefined}
      />
    </Container>
  );
}
