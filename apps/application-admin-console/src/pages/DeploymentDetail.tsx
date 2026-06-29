import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { JOB_ID_RE, parseStackOutputs } from "../api/deploy-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { buildTerminalLog, deploySummaryTitle, derivePhases } from "../lib/deploy-phases";
import { BasicInfoSection } from "./deployment-detail/BasicInfoSection";
import { CfnOutputsSection } from "./deployment-detail/CfnOutputsSection";
import { CompositeTargetsSection } from "./deployment-detail/CompositeTargetsSection";
import { DeployLogSection } from "./deployment-detail/DeployLogSection";
import { DeploySummaryStyles } from "./deployment-detail/DeploySummaryStyles";
import {
  FailureGuidanceSection,
  shouldShowFailureGuidance,
} from "./deployment-detail/FailureGuidanceSection";
import { HandoffSection } from "./deployment-detail/HandoffSection";
import { ProvenanceSummarySection } from "./deployment-detail/ProvenanceSummarySection";
import { TerminalLogView } from "./deployment-detail/TerminalLogView";
import { useDeploymentDetail } from "./deployment-detail/useDeploymentDetail";

/**
 * #1091: 黒い Netlify 風 banner を撤去し Cloudscape の標準 Header に揃える。
 *   個別 deployment の削除は ここから行わず、 Event 全体の teardown
 *   (= EventDetail の bulk teardown modal) に一本化する。
 *
 * 構成は `./deployment-detail/` 配下の sub-component に分割している (#1240):
 *   - useDeploymentDetail — 30s polling + StackProgress 並列 fetch
 *   - DeployLogSection — Netlify-style phase list + 操作 (#534)
 *   - BasicInfoSection / HandoffSection / CfnOutputsSection — 静的な情報セクション
 *   - PhaseRow / StackProgressBody / TerminalLogView — log / CFn 進行状況の描画
 */
export function DeploymentDetailPage({ config }: { config: AppConfig }) {
  const { jobId } = useParams<{ jobId: string }>();
  const t = useT();
  const [logModalOpen, setLogModalOpen] = useState(false);
  const {
    item,
    error,
    manualRefreshing,
    stackProgress,
    stackProgressError,
    stackProgressPending,
    reload,
  } = useDeploymentDetail(config, jobId);

  const phases = useMemo(
    () => (item ? derivePhases(item, stackProgress) : []),
    [item, stackProgress],
  );
  const terminalLog = useMemo(
    () => (item ? buildTerminalLog(item, stackProgress, phases) : []),
    [item, stackProgress, phases],
  );

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return <Alert type="error">{t("deployment_detail.invalid_job_id")}</Alert>;
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("deployment_detail.loading_status")}
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header={t("deployment_detail.fetch_failed_header")}>
        {error}
      </Alert>
    );
  }

  // 上の loading (!item && !error) / error (error && !item) guard を抜けた時点で item は必ず
  // non-null (型 narrowing 用の防御 guard、 return は不到達)。
  /* v8 ignore next */
  if (!item) return null;

  const outputs = parseStackOutputs(item.stackOutputs);
  const teamLoginKey = item.teamLoginKey;
  const summaryTitle = deploySummaryTitle(item);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`${item.problemId} · ${item.displayTeamName ?? item.teamName} · Job ${item.jobId}`}
        actions={
          <Button onClick={reload} loading={manualRefreshing}>
            {t("deployment_detail.reload")}
          </Button>
        }
      >
        {summaryTitle}
      </Header>

      {item.status === "FAILED" && item.failureReason && (
        <Alert type="error" header={t("deployment_detail.failure_reason_header")}>
          {item.failureReason}
        </Alert>
      )}

      {shouldShowFailureGuidance(item.status) && (
        <FailureGuidanceSection problemId={item.problemId} t={t} />
      )}

      <DeployLogSection
        deployment={item}
        phases={phases}
        stackProgress={stackProgress}
        stackProgressError={stackProgressError}
        stackProgressPending={stackProgressPending}
        onMaximize={() => setLogModalOpen(true)}
        t={t}
      />

      {/* #2074: composite (multi-cloud) parent のときだけ per-target 進捗を表示する。
          legacy single-provider deployment は item.composite が undefined なので
          この section ごと描画されず、旧 UI は byte 互換のまま。 */}
      {item.composite && <CompositeTargetsSection composite={item.composite} t={t} />}

      <BasicInfoSection item={item} t={t} />

      {teamLoginKey && <HandoffSection teamLoginKey={teamLoginKey} t={t} />}

      {Object.keys(outputs).length > 0 && <CfnOutputsSection outputs={outputs} t={t} />}

      {/* [#2096] Pack-sourced deployments only; hidden for core problems. */}
      <ProvenanceSummarySection deployment={item} t={t} />

      {/* Maximize log: terminal-style 全 phase の log。Cloudscape の Modal size="max"。 */}
      <Modal
        visible={logModalOpen}
        onDismiss={() => setLogModalOpen(false)}
        header={t("deployment_detail.deploy_log_header")}
        size="max"
        data-testid="deploy-log-modal"
      >
        <TerminalLogView lines={terminalLog} />
      </Modal>

      <DeploySummaryStyles />
    </SpaceBetween>
  );
}
