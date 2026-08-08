import { fetchPipelineExecutions, type PipelineExecutionItem } from "../api/admin-drill-down";
import type { AppConfig } from "../config";
import { type ExecutionsState, useStateMachineExecutions } from "./useStateMachineExecutions";

/**
 * Issue #658: `tenkacloud-saas-pipeline` (= ServerlessSaaSPipeline) の execution 履歴を
 * 60s polling で取得する hook。
 *
 * 取得・polling・4 状態 (loading / not-configured / forbidden / error) の管理は、 Step Functions 側と
 * 完全に同型なので `useStateMachineExecutions` に集約した。 ここは「どの route を叩くか」と item 型
 * だけを決める。
 *
 * この pipeline は tenant template を deploy するためのものであって、 テナントのプロビジョニング本体
 * ではない (= それは ProvisioningScriptJob の state machine)。 表示先は「デプロイ Pipeline」タブ。
 */
export type ProvisioningJobsState = ExecutionsState<PipelineExecutionItem>;

export function useProvisioningJobs(config: AppConfig): ProvisioningJobsState {
  return useStateMachineExecutions<PipelineExecutionItem>(config, fetchPipelineExecutions);
}
