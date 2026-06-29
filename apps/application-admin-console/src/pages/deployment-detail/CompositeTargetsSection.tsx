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

/**
 * [Composite Runtime / Issue #2074] Composite (multi-cloud) parent の per-target
 * status を表示する。`item.composite` が存在する composite parent でだけ
 * DeploymentDetail から描画され、legacy single-provider deployment では
 * 一切レンダリングされない (= 旧 UI を byte 互換に保つ)。
 *
 * Backend (`buildCompositeDetail`, #2073) が credential / role / login-key を
 * 落とした whitelist だけを返すため、ここで扱う target 行は display-only であり
 * 認可入力には決して使わない。
 */
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
        ariaLabels={{
          tableLabel: t("deployment_detail.composite_targets_header"),
        }}
      />
    </Container>
  );
}
