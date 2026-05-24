import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import {
  type StackProgress,
  type StackProgressEvent,
  type StackProgressResource,
  statusToIndicator,
} from "../../api/deploy-client";
import type { StackProgressErrorState, TFn } from "./types";

/**
 * #534: CFn 進行状況セクション。Events / Resources / Console deep link を出す。
 * Phase 3 (CloudFormation Deploy) の body として PhaseBody から呼ばれる。
 */
export function StackProgressBody(props: {
  readonly progress: StackProgress | null;
  readonly error: StackProgressErrorState | null;
  readonly pending: boolean;
  readonly t: TFn;
}) {
  const { progress, error, pending, t } = props;

  if (!progress && !error && pending) {
    return (
      <Box textAlign="center" padding="m">
        <Spinner /> {t("deployment_detail.stack_loading")}
      </Box>
    );
  }

  if (error && !progress) {
    return error.notYetCreated ? (
      <Box color="text-status-info">{t("deployment_detail.stack_not_yet_created")}</Box>
    ) : (
      <Alert type="warning" header={t("deployment_detail.stack_fetch_failed_header")}>
        {error.message}
      </Alert>
    );
  }

  if (!progress) return null;

  const firstFailure = progress.events.find((e) => e.resourceStatus.endsWith("_FAILED"));

  return (
    <SpaceBetween size="m">
      <Box>
        <Link href={progress.consoleUrl} external>
          {t("deployment_detail.open_cfn_console")}
        </Link>
        {progress.stackStatus && (
          <Box variant="small" margin={{ top: "xxs" }}>
            {t("deployment_detail.stack_status_label")}: <code>{progress.stackStatus}</code>
          </Box>
        )}
      </Box>

      {firstFailure && (
        <Alert
          type="error"
          header={t("deployment_detail.failure_alert_header", {
            logicalId: firstFailure.logicalResourceId,
          })}
        >
          <Box>
            {t("deployment_detail.failure_body", {
              resourceType: firstFailure.resourceType,
              status: firstFailure.resourceStatus,
            })}
          </Box>
          {firstFailure.resourceStatusReason && (
            <Box variant="small">{firstFailure.resourceStatusReason}</Box>
          )}
        </Alert>
      )}

      {progress.stuck?.isStuck && (
        <Alert type="warning" header={t("deployment_detail.stuck_header")}>
          <SpaceBetween size="xs">
            <Box>
              {t("deployment_detail.stuck_elapsed", { minutes: progress.stuck.elapsedMinutes })}
              {progress.stuck.resourceLogicalId && (
                <>
                  {" "}
                  {t("deployment_detail.stuck_target")}:{" "}
                  <code>{progress.stuck.resourceLogicalId}</code>
                  {progress.stuck.resourceStatus ? (
                    <>
                      {" "}
                      (<code>{progress.stuck.resourceStatus}</code>)
                    </>
                  ) : null}
                </>
              )}
            </Box>
            <Box>{progress.stuck.reason}</Box>
            <Box variant="small">{progress.stuck.remediationHint}</Box>
          </SpaceBetween>
        </Alert>
      )}

      <Table<StackProgressEvent>
        variant="embedded"
        header={
          <Header variant="h3">
            {t("deployment_detail.events_header", { count: progress.events.length })}
          </Header>
        }
        items={[...progress.events]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            {t("deployment_detail.events_empty")}
          </Box>
        }
        columnDefinitions={[
          {
            id: "timestamp",
            header: t("deployment_detail.col_timestamp"),
            cell: (e) => e.timestamp,
            width: 200,
          },
          {
            id: "logicalResourceId",
            header: t("deployment_detail.col_logical_id"),
            cell: (e) => <code>{e.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: t("deployment_detail.col_resource_type"),
            cell: (e) => <code>{e.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: t("deployment_detail.col_status"),
            cell: (e) => (
              <StatusIndicator type={statusToIndicator(e.resourceStatus)}>
                {e.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "reason",
            header: t("deployment_detail.col_reason"),
            cell: (e) => e.resourceStatusReason ?? "",
          },
        ]}
      />

      <Table<StackProgressResource>
        variant="embedded"
        header={
          <Header variant="h3">
            {t("deployment_detail.resources_header", { count: progress.resources.length })}
          </Header>
        }
        items={[...progress.resources]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            {t("deployment_detail.resources_empty")}
          </Box>
        }
        columnDefinitions={[
          {
            id: "logicalResourceId",
            header: t("deployment_detail.col_logical_id"),
            cell: (r) => <code>{r.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: t("deployment_detail.col_resource_type"),
            cell: (r) => <code>{r.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: t("deployment_detail.col_status"),
            cell: (r) => (
              <StatusIndicator type={statusToIndicator(r.resourceStatus)}>
                {r.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "physicalResourceId",
            header: t("deployment_detail.col_physical_id"),
            cell: (r) => (r.physicalResourceId ? <code>{r.physicalResourceId}</code> : ""),
          },
        ]}
      />
    </SpaceBetween>
  );
}
