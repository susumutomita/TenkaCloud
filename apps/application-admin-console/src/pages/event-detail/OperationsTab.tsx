import Alert from "@cloudscape-design/components/alert";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventRescuePanel } from "../../components/event-detail/EventWizardPanel";
import { CapacityPanel } from "./CapacityPanel";
import type { EventTabContentProps } from "./tab-content-props";

/**
 * Operations tab: 普段使わない高度操作を集約する。
 *
 * デプロイ / 撤去 のライフサイクル操作は「スケジュール」tab に集約したので (= 予約 + 即座に の
 * 一貫した 1 箇所)、 この tab に残すのは復旧 (rescue) と進捗の確認だけ。 status を問わず内容を
 * 持たせる (issue #1328 の「非 TEARDOWN で空 tab」回帰を防ぐ)。
 *
 * 表示 section:
 *  1. EventRescuePanel — status === TEARDOWN のときだけ render する force-archive 復旧
 *  2. Deploy 進捗詳細 — DeployProgressPanel。 deployment が 0 件のときは empty hint
 *  3. CapacityPanel — イベント中の DynamoDB キャパ監視 (#2410、TenantAdmin のみ read 可)
 */
export function OperationsTab({
  apiClient,
  canMutateTenant,
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  operations,
  t,
}: EventTabContentProps) {
  return (
    <SpaceBetween size="l">
      <Header variant="h2">{t("event_detail.operations_header")}</Header>
      <Alert type="info" data-testid="operations-tab-intro">
        {t("event_detail.operations_intro")}
      </Alert>

      <EventRescuePanel
        canMutateTenant={canMutateTenant}
        detail={detail}
        forceArchiveInFlight={operations.forceArchiveInFlight}
        onForceArchive={() => operations.setConfirmForceArchive(true)}
        t={t}
      />

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

      <CapacityPanel apiClient={apiClient} t={t} />
    </SpaceBetween>
  );
}
