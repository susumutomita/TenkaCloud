import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import {
  type CompositeDetail,
  type CompositeTargetSummary,
  DEPLOYMENT_STATUS_INDICATOR,
} from "../../api/deploy-client";
import type { TFn } from "./types";

const DEPENDENCY_INDICATOR = {
  ready: "pending",
  waiting: "pending",
  running: "in-progress",
  complete: "success",
  blocked: "error",
} as const;

export function CompositeTargetsSection({
  composite,
  t,
}: {
  readonly composite: CompositeDetail;
  readonly t: TFn;
}) {
  return (
    <Container
      header={
        <Header
          variant="h2"
          counter={`(${composite.targets.length})`}
          description={t("deployment_detail.composite_targets_description")}
        >
          {t("deployment_detail.composite_targets_header")}
        </Header>
      }
    >
      <Table<CompositeTargetSummary>
        variant="embedded"
        items={[...composite.targets]}
        trackBy="targetId"
        empty={t("deployment_detail.composite_targets_empty")}
        columnDefinitions={[
          {
            id: "targetId",
            header: t("deployment_detail.composite_col_target"),
            cell: (item) => (
              <code data-testid={`composite-target-${item.targetId}`}>{item.targetId}</code>
            ),
          },
          {
            id: "provider",
            header: t("deployment_detail.composite_col_provider"),
            cell: (item) => item.provider,
          },
          {
            id: "engine",
            header: t("deployment_detail.composite_col_engine"),
            cell: (item) => <code>{item.engine}</code>,
          },
          {
            id: "dependencyState",
            header: t("deployment_detail.composite_col_dependency_state"),
            cell: (item) =>
              item.dependencyState ? (
                <StatusIndicator type={DEPENDENCY_INDICATOR[item.dependencyState]}>
                  {t(`deployment_detail.composite_dependency_${item.dependencyState}`)}
                </StatusIndicator>
              ) : (
                t("deployment_detail.composite_dependency_legacy")
              ),
          },
          {
            id: "dependsOn",
            header: t("deployment_detail.composite_col_dependencies"),
            cell: (item) =>
              item.dependsOn && item.dependsOn.length > 0
                ? item.dependsOn.join(", ")
                : t("common.none"),
          },
          {
            id: "inputs",
            header: t("deployment_detail.composite_col_bound_inputs"),
            cell: (item) =>
              item.inputParameters && item.inputParameters.length > 0
                ? item.inputParameters.join(", ")
                : t("common.none"),
          },
          {
            id: "status",
            header: t("deployment_detail.composite_col_status"),
            cell: (item) => (
              <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
                {item.status}
              </StatusIndicator>
            ),
          },
          {
            id: "failureReason",
            header: t("deployment_detail.composite_col_failure_reason"),
            cell: (item) =>
              item.status === "FAILED" && item.failureReason
                ? item.failureReason
                : t("deployment_detail.composite_failure_reason_none"),
          },
        ]}
        ariaLabels={{ tableLabel: t("deployment_detail.composite_targets_header") }}
      />
    </Container>
  );
}
