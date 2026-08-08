import { fetchStateMachineExecutions } from "../api/admin-drill-down";
import type { AppConfig } from "../config";
import {
  type StateMachineExecutionsState,
  useStateMachineExecutions,
} from "./useStateMachineExecutions";

/**
 * Issue #814 Phase 2: Deprovisioning Jobs (= SBT BashJobRunner の `deprovisioningJobRunner` が動かす
 * Step Functions State Machine の execution 履歴) を取得する hook。
 *
 * 取得ロジックは provisioning 側と同一なので `useStateMachineExecutions` に集約し、 ここは route の
 * 選択だけを担う。
 */
export type DeprovisioningJobsState = StateMachineExecutionsState;

export function useDeprovisioningJobs(config: AppConfig): DeprovisioningJobsState {
  return useStateMachineExecutions(config, fetchStateMachineExecutions);
}
