import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventRescuePanel } from "../../components/event-detail/EventWizardPanel";
import { isTerminalEventStatus } from "../../lib/effective-event-status";
import type { EventTabContentProps } from "./tab-content-props";

/**
 * Operations tab: 普段使わない高度操作を集約する。
 *
 * Issue #1318 で 「rescue 系を Operations に集約」 と決めたが、 #1324 で実装したときに
 * EventRescuePanel (TEARDOWN 時のみ render) のみを置いてしまい、 非 TEARDOWN 状態では
 * tab が完全に空になっていた (issue #1328)。 本コミットで 4 section を常時表示するようにし、
 * status を問わず 運用 tab に内容があることを保証する。
 *
 * 表示 section:
 *  1. EventRescuePanel — 既存。 status === TEARDOWN のときだけ render
 *  2. 一括操作 — Bulk redeploy / Bulk teardown。 header にも同等 button があるが Operations tab
 *     の主目的 (= 高度操作の集約先) として明示的に重複配置する
 *  3. Deploy 進捗詳細 — DeployProgressPanel。 deployment が 0 件のときは empty hint
 *  4. Event 削除 (danger zone) — header の Delete と同じ confirmTeardown modal を開く
 */
export function OperationsTab({
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  operations,
  t,
}: EventTabContentProps) {
  const bulkDisabled = isTerminalEventStatus(detail.status);
  return (
    <SpaceBetween size="l">
      <Header variant="h2">{t("event_detail.operations_header")}</Header>
      <Alert type="info" data-testid="operations-tab-intro">
        {t("event_detail.operations_intro")}
      </Alert>

      <EventRescuePanel
        detail={detail}
        forceArchiveInFlight={operations.forceArchiveInFlight}
        onForceArchive={() => operations.setConfirmForceArchive(true)}
        t={t}
      />

      <Container
        data-testid="operations-bulk-section"
        header={
          <Header variant="h3" description={t("event_detail.operations_bulk_description")}>
            {t("event_detail.operations_bulk_header")}
          </Header>
        }
      >
        <SpaceBetween size="xs" direction="horizontal">
          <Button
            data-testid="operations-bulk-deploy"
            loading={operations.bulkInFlight === "deploy"}
            disabled={
              detail.problems.length === 0 ||
              detail.teams.length === 0 ||
              bulkDisabled ||
              operations.bulkInFlight !== null
            }
            onClick={() => void operations.handleBulkDeploy()}
          >
            {t("event_detail.operations_bulk_deploy")}
          </Button>
          <Button
            data-testid="operations-bulk-teardown"
            loading={operations.bulkInFlight === "teardown"}
            disabled={operations.bulkInFlight !== null}
            onClick={() => operations.setConfirmTeardown(true)}
          >
            {t("event_detail.operations_bulk_teardown")}
          </Button>
        </SpaceBetween>
      </Container>

      <Container
        header={<Header variant="h3">{t("event_detail.operations_deploy_progress_header")}</Header>}
      >
        {counts.totalDeployCount > 0 ? (
          <DeployProgressPanel
            allDoneCount={counts.allDoneCount}
            completeCount={counts.completeCount}
            failedCount={counts.failedCount}
            inFlightCount={counts.inFlightCount}
            manualRefreshInFlight={manualRefreshInFlight}
            onManualRefresh={manualRefresh}
            t={t}
            totalDeployCount={counts.totalDeployCount}
          />
        ) : (
          <Alert type="info">{t("event_detail.operations_deploy_progress_empty")}</Alert>
        )}
      </Container>

      <Container
        data-testid="operations-delete-section"
        header={
          <Header
            variant="h3"
            actions={
              <Button
                variant="primary"
                data-testid="operations-delete-button"
                loading={operations.bulkInFlight === "teardown"}
                onClick={() => operations.setConfirmTeardown(true)}
              >
                {t("event_detail.operations_delete_button")}
              </Button>
            }
          >
            {t("event_detail.operations_delete_header")}
          </Header>
        }
      >
        <Alert type="warning">{t("event_detail.operations_delete_warning")}</Alert>
      </Container>
    </SpaceBetween>
  );
}
