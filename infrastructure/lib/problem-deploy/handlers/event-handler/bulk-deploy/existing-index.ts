import type { DeploymentItem } from "../../deploy-handler/types.js";
import type { ExistingDeploymentIndex } from "./types.js";

/**
 * 既存 deployment 行を (teamId, problemId) で index 化する。
 * - `existingKey`: 全行 (= 重複検出)
 * - `failedByKey`: FAILED 行 (= retryFailedOnly モードで replace 対象を引く)
 * - `forceRedeployByKey`: COMPLETE / FAILED / DELETED 行 (= forceRedeploy モードで replace 対象を引く)
 *
 * 同じ key に複数行ある場合は最初に来た 1 件を採用 (Map.set の has check 経由)。
 */
export function indexExistingDeployments(
  existing: readonly Partial<DeploymentItem>[],
): ExistingDeploymentIndex {
  const index: ExistingDeploymentIndex = {
    failedByKey: new Map(),
    forceRedeployByKey: new Map(),
    existingKey: new Set(),
  };
  for (const deployment of existing) addExistingDeployment(index, deployment);
  return index;
}

function addExistingDeployment(
  index: ExistingDeploymentIndex,
  deployment: Partial<DeploymentItem>,
): void {
  const teamId = String(deployment.teamId ?? "");
  const problemId = String(deployment.problemId ?? "");
  if (!teamId || !problemId) return;
  const key = `${teamId} ${problemId}`;
  index.existingKey.add(key);
  if (deployment.status === "FAILED" && !index.failedByKey.has(key)) {
    index.failedByKey.set(key, { jobId: String(deployment.jobId ?? "") });
  }
  if (isForceRedeployStatus(deployment.status) && !index.forceRedeployByKey.has(key)) {
    index.forceRedeployByKey.set(key, { jobId: String(deployment.jobId ?? "") });
  }
}

function isForceRedeployStatus(status: unknown): boolean {
  return status === "COMPLETE" || status === "FAILED" || status === "DELETED";
}
