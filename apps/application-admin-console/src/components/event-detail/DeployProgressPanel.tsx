import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Pagination from "@cloudscape-design/components/pagination";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import { DEPLOYMENT_STATUS_INDICATOR } from "../../api/deploy-client";
import type { EventDetail } from "../../api/events-client";
import { localDeployProgress } from "./local-deploy-progress";

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
 * 「何件中何件が動いているか」と各チーム・問題の実際の状態を表示する。
 */
export function DeployProgressPanel({
  allDoneCount,
  completeCount,
  cloudDetail,
  ended,
  failedCount,
  inFlightCount,
  localDetail,
  manualRefreshInFlight,
  onManualRefresh,
  t,
  totalDeployCount,
}: {
  readonly allDoneCount: number;
  readonly completeCount: number;
  readonly cloudDetail?: EventDetail;
  /** The event has ended: an explicit terminal status, or READY past its reserved end time. */
  readonly ended: boolean;
  readonly failedCount: number;
  readonly inFlightCount: number;
  readonly localDetail?: EventDetail;
  readonly manualRefreshInFlight: boolean;
  readonly onManualRefresh: () => void;
  readonly t: Translate;
  readonly totalDeployCount: number;
}) {
  const [pageIndex, setPageIndex] = useState(1);
  const rows = Object.entries(cloudDetail?.deploymentsByProblem ?? {}).flatMap(
    ([problemId, deployments]) => deployments.map((deployment) => ({ ...deployment, problemId })),
  );
  const pagesCount = Math.max(1, Math.ceil(rows.length / 10));
  const currentPage = Math.min(pageIndex, pagesCount);
  const localProgress = localDetail ? localDeployProgress(localDetail, ended, t) : undefined;
  if (!localProgress && totalDeployCount <= 0) return null;
  const {
    type: status,
    label: statusLabel,
    description: statusDescription,
  } = localProgress ??
  computeDeployStatus(t, {
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
            localProgress?.summary ??
            (failedCount > 0
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
                }))
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
          {t(localProgress ? "local_host.progress_header" : "event_detail.deploy_progress_header")}
        </Header>
      }
    >
      <SpaceBetween size="xs">
        <StatusIndicator type={status}>{statusLabel}</StatusIndicator>
        <Box variant="small" color="text-body-secondary">
          {statusDescription}
        </Box>
        {(localProgress ? localProgress.inFlight : inFlightCount > 0) && (
          <Box variant="small" color="text-status-info">
            {t(
              localProgress
                ? "event_detail.deploy_progress_auto_refresh_local"
                : "event_detail.deploy_progress_auto_refresh",
            )}
          </Box>
        )}
        {cloudDetail && rows.length > 0 && (
          <Table
            variant="embedded"
            ariaLabels={{ tableLabel: t("event_detail.deploy_progress_details") }}
            items={rows.slice((currentPage - 1) * 10, currentPage * 10)}
            trackBy="jobId"
            columnDefinitions={[
              {
                id: "team",
                header: t("event_detail.deploy_progress_team"),
                cell: (row) => {
                  const team = cloudDetail.teams.find((team) => team.teamId === row.teamId);
                  return team?.displayName ?? team?.internalSlug ?? row.teamId;
                },
              },
              {
                id: "problem",
                header: t("event_detail.deploy_progress_problem"),
                cell: (row) => row.problemId,
              },
              {
                id: "status",
                header: t("event_detail.deploy_progress_status"),
                cell: (row) => (
                  <StatusIndicator
                    type={
                      row.status === "STOPPED" ? "stopped" : DEPLOYMENT_STATUS_INDICATOR[row.status]
                    }
                  >
                    {t(`event_detail.deploy_progress_status_${row.status.toLowerCase()}`)}
                  </StatusIndicator>
                ),
              },
            ]}
            pagination={
              pagesCount > 1 ? (
                <Pagination
                  currentPageIndex={currentPage}
                  pagesCount={pagesCount}
                  onChange={({ detail }) => setPageIndex(detail.currentPageIndex)}
                  ariaLabels={{
                    nextPageLabel: t("event_detail.deploy_progress_next"),
                    previousPageLabel: t("event_detail.deploy_progress_previous"),
                    pageLabel: (page) => String(page),
                  }}
                />
              ) : undefined
            }
          />
        )}
      </SpaceBetween>
    </Container>
  );
}
