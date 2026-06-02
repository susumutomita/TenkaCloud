/**
 * [ADR-031 / ADR-029 INV-2 / Issue #1419] executor の `scheduleRevert` dep 具体実装。
 *
 * 注入と同時に「afterSeconds 後に 1 度だけ復旧する」 one-shot schedule を aws-scheduler に登録する
 * (= ADR-031 で選定した機構)。 schedule は executor Lambda 自身を `mode:"revert"` payload で呼び戻す:
 * revert 時刻には注入時の credentials は失効しているため、 payload は DeploymentTarget (= roleArn /
 * externalIdParameterName / region / stackOutputs) と **構築済の revert dispatch** を運び、 handler は
 * 再 AssumeRole して送るだけにする (= re-lookup 不要、 注入時の決定を凍結)。
 *
 * - name は `EXEC#` と対の冪等キー (= 同 requestId/teamId の重複 fire で同名 → CreateSchedule が衝突を弾く)。
 * - FlexibleTimeWindow=OFF / ActionAfterCompletion=DELETE (= 発火後に自動削除、 schedule が溜まらない)。
 * - schedule が target を起動するための RoleArn は construct が作り env 経由で注入 (= deps.schedulerRoleArn)。
 *
 * SDK error は握り潰さず伝播 (= 復旧予約に失敗したら loud にする。 INV-2 を黙って破らない)。
 */

import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  type SchedulerClient,
  ScheduleState,
} from "@aws-sdk/client-scheduler";
import type { DisruptionDispatch } from "./dispatch-command.js";
import type { DeploymentTarget, DisruptionFiredDetail } from "./execute.js";

export interface ScheduleRevertDeps {
  readonly scheduler: Pick<SchedulerClient, "send">;
  /** schedule が target を起動するために assume する role の ARN (= construct が作成、 env 注入)。 */
  readonly schedulerRoleArn: string;
  /** revert を実行する target (= executor Lambda 自身) の ARN。 */
  readonly revertTargetArn: string;
}

const MAX_SCHEDULE_NAME = 64;

/** `EXEC#{requestId}#{teamId}` と対の冪等な schedule 名。 aws-scheduler の name 制約に sanitize。 */
export function revertScheduleName(detail: DisruptionFiredDetail): string {
  return `tc-revert-${detail.requestId}-${detail.teamId}`
    .replace(/[^0-9A-Za-z\-_.]/g, "-")
    .slice(0, MAX_SCHEDULE_NAME);
}

/** firedAt + afterSeconds の UTC 時刻を aws-scheduler の `at(...)` 式 (秒精度) に。 */
export function revertAtExpression(firedAtIso: string, afterSeconds: number): string {
  const at = new Date(new Date(firedAtIso).getTime() + afterSeconds * 1000);
  return `at(${at.toISOString().slice(0, 19)})`;
}

export async function scheduleRevert(
  revert: DisruptionDispatch,
  detail: DisruptionFiredDetail,
  target: DeploymentTarget,
  afterSeconds: number,
  deps: ScheduleRevertDeps,
): Promise<void> {
  await deps.scheduler.send(
    new CreateScheduleCommand({
      Name: revertScheduleName(detail),
      ScheduleExpression: revertAtExpression(detail.firedAt, afterSeconds),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      State: ScheduleState.ENABLED,
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Target: {
        Arn: deps.revertTargetArn,
        RoleArn: deps.schedulerRoleArn,
        Input: JSON.stringify({ mode: "revert", detail, dispatch: revert, target }),
      },
    }),
  );
}
