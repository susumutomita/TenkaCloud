import { fetchProvisioningExecutions } from "../api/admin-drill-down";
import type { AppConfig } from "../config";
import {
  type StateMachineExecutionsState,
  useStateMachineExecutions,
} from "./useStateMachineExecutions";

/**
 * SBT ProvisioningScriptJob の Step Functions execution 履歴を取得する hook。
 *
 * テナントのプロビジョニングが実際に走るのはこの state machine で、 Provisioning Jobs 画面が長らく
 * 見ていた CodePipeline (`tenkacloud-saas-pipeline`) とは別経路だった。 そのため 3 テナントを
 * 同時に provisioning しても画面には 1 件も出ず、 代わりに無関係な pipeline の失敗だけが
 * 「プロビジョニング失敗」として表示されていた (2026-08-08 に運用者が誤認)。
 */
export function useProvisioningExecutions(config: AppConfig): StateMachineExecutionsState {
  return useStateMachineExecutions(config, fetchProvisioningExecutions);
}
