import Link from "@cloudscape-design/components/link";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { NavigateFunction } from "react-router";
import { DEPLOYMENT_STATUS_INDICATOR, type DeploymentSummary } from "../api/deploy-client";

/**
 * Deployments / ProblemDetail の deployment 一覧 table で完全に重複していた cell renderer を
 * 共有する (DRY)。 列の `header` (i18n key) は page ごとに違うので各 page 側で持ち、 cell の
 * 描画ロジックだけをここへ集約する。
 */

/** team 列: 表示名 (displayTeamName ?? teamName) を deployment 詳細への internal link にする。 */
export function deploymentTeamCell(navigate: NavigateFunction) {
  return (item: DeploymentSummary) => (
    <Link
      fontSize="body-m"
      href={`/deployments/${encodeURIComponent(item.jobId)}`}
      onFollow={(e) => {
        e.preventDefault();
        navigate(`/deployments/${encodeURIComponent(item.jobId)}`);
      }}
    >
      {item.displayTeamName ?? item.teamName}
    </Link>
  );
}

/** status 列: deployment status を Cloudscape の StatusIndicator にマップする。 */
export function deploymentStatusCell(item: DeploymentSummary) {
  return (
    <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>{item.status}</StatusIndicator>
  );
}

/** stack name 列: CFn StackName prefix を code 表記する。 */
export function deploymentStackNameCell(item: DeploymentSummary) {
  return <code>{item.namePrefix}</code>;
}
