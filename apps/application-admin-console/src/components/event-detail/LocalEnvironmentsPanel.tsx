import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type EventDeploymentStatus,
  type EventDeploymentSummary,
  type EventDetail,
  type LocalEnvironmentOperation,
  operateLocalEnvironment,
} from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

interface EnvironmentRow extends EventDeploymentSummary {
  readonly problemId: string;
  readonly teamSlug: string;
}

const STATUS_TYPE: Partial<Record<EventDeploymentStatus, StatusIndicatorProps.Type>> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  STOPPED: "stopped",
  DELETING: "in-progress",
  DELETED: "stopped",
};
const SETTLED: ReadonlySet<EventDeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "STOPPED",
  "DELETED",
]);

/**
 * The same rules the local host enforces (`assertJobOperation`), so an unavailable operation is
 * a disabled button with its reason on the page, not a request that fails.
 */
export function allowedLocalOperations(
  eventStatus: EventDetail["status"],
  row: Pick<EventDeploymentSummary, "status" | "operation">,
): Readonly<Record<LocalEnvironmentOperation, boolean>> {
  if (row.operation || !SETTLED.has(row.status))
    return { stop: false, restart: false, teardown: false };
  return {
    stop: ["DEPLOYING", "READY", "ENDED"].includes(eventStatus) && row.status === "COMPLETE",
    restart: eventStatus === "DEPLOYING" || eventStatus === "READY",
    teardown: eventStatus !== "ARCHIVED" && row.status !== "DELETED",
  };
}

function environmentRows(detail: EventDetail): EnvironmentRow[] {
  const slugs = new Map(detail.teams.map((team) => [team.teamId, team.internalSlug]));
  return Object.entries(detail.deploymentsByProblem).flatMap(([problemId, deployments]) =>
    deployments.map((deployment) => ({
      ...deployment,
      problemId,
      teamSlug: slugs.get(deployment.teamId) ?? deployment.teamId,
    })),
  );
}

/**
 * Issue #3226: one row per team/problem environment on the local competition host, with
 * stop / restart / teardown for exactly that environment. The host runs each environment as
 * its own Docker Compose project behind its own gateway, so an operation here never touches
 * another team's containers, gateway or score.
 */
export function LocalEnvironmentsPanel({
  apiClient,
  canMutateTenant,
  detail,
  onRefresh,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly onRefresh: () => void;
  readonly t: Translate;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTeardown, setConfirmTeardown] = useState<EnvironmentRow | null>(null);
  const rows = environmentRows(detail);

  const operate = async (row: EnvironmentRow, operation: LocalEnvironmentOperation) => {
    /* v8 ignore next -- the buttons are disabled without a client */
    if (!apiClient) return;
    setPending(row.jobId);
    setError(null);
    try {
      await operateLocalEnvironment(apiClient, detail.eventId, row.jobId, operation);
      onRefresh();
    } catch (cause) {
      setError(
        t("local_host.env_operation_failed", {
          team: row.teamSlug,
          reason: toErrorMessage(cause),
        }),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <Container
      header={
        <Header variant="h2" description={t("local_host.env_description")}>
          {t("local_host.env_header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        <Table
          variant="embedded"
          items={rows}
          trackBy="jobId"
          empty={<Box>{t("local_host.env_empty")}</Box>}
          columnDefinitions={[
            { id: "team", header: t("local_host.env_col_team"), cell: (row) => row.teamSlug },
            {
              id: "problem",
              header: t("local_host.env_col_problem"),
              cell: (row) => <code>{row.problemId}</code>,
            },
            {
              id: "status",
              header: t("local_host.env_col_status"),
              cell: (row) => (
                <SpaceBetween size="xxs">
                  <StatusIndicator type={row.operation ? "in-progress" : STATUS_TYPE[row.status]}>
                    {row.operation
                      ? t(`local_host.env_operation_${row.operation}`)
                      : t(`local_host.env_status_${row.status}`)}
                  </StatusIndicator>
                  {row.error && (
                    <Box variant="small" color="text-status-error">
                      {row.error}
                    </Box>
                  )}
                </SpaceBetween>
              ),
            },
            {
              id: "gateway",
              header: t("local_host.env_col_gateway"),
              cell: (row) =>
                row.gatewayPort === undefined ? "—" : <code>{String(row.gatewayPort)}</code>,
            },
            {
              id: "actions",
              header: t("local_host.env_col_actions"),
              cell: (row) => {
                const allowed = allowedLocalOperations(detail.status, row);
                const blocked = !apiClient || !canMutateTenant || pending !== null;
                return (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      disabled={blocked || !allowed.stop}
                      loading={pending === row.jobId}
                      ariaLabel={t("local_host.env_stop_aria", { team: row.teamSlug })}
                      onClick={() => void operate(row, "stop")}
                    >
                      {t("local_host.env_stop")}
                    </Button>
                    <Button
                      disabled={blocked || !allowed.restart}
                      ariaLabel={t("local_host.env_restart_aria", { team: row.teamSlug })}
                      onClick={() => void operate(row, "restart")}
                    >
                      {t("local_host.env_restart")}
                    </Button>
                    <Button
                      disabled={blocked || !allowed.teardown}
                      ariaLabel={t("local_host.env_teardown_aria", { team: row.teamSlug })}
                      onClick={() => setConfirmTeardown(row)}
                    >
                      {t("local_host.env_teardown")}
                    </Button>
                  </SpaceBetween>
                );
              },
            },
          ]}
        />
        <Box variant="small" color="text-body-secondary">
          {t("local_host.env_rules")}
        </Box>
      </SpaceBetween>
      {confirmTeardown && (
        <TeardownConfirmation
          row={confirmTeardown}
          onCancel={() => setConfirmTeardown(null)}
          onConfirm={() => {
            setConfirmTeardown(null);
            void operate(confirmTeardown, "teardown");
          }}
          t={t}
        />
      )}
    </Container>
  );
}

/** Removing a team's containers and data is not undoable, so it is confirmed first. */
function TeardownConfirmation({
  row,
  onCancel,
  onConfirm,
  t,
}: {
  readonly row: EnvironmentRow;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible
      onDismiss={onCancel}
      header={t("local_host.env_teardown_confirm_header", { team: row.teamSlug })}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onCancel}>{t("event_detail.modal_cancel")}</Button>
            <Button variant="primary" onClick={onConfirm}>
              {t("local_host.env_teardown")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {t("local_host.env_teardown_confirm_body")}
    </Modal>
  );
}
