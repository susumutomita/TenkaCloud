/**
 * [Issue #1419] executor の `scheduleRevert` dep 具体実装。
 *
 * 注入と同時に「afterSeconds 後に 1 度だけ復旧する」 one-shot schedule を aws-scheduler に登録する
 * (選定した機構)。 schedule は executor Lambda 自身を `mode:"revert"` payload で呼び戻す:
 * revert 時刻には注入時の credentials は失効しているため、 payload は DeploymentTarget (= roleArn /
 * externalIdParameterName / region / stackOutputs) と **構築済の revert dispatch** を運び、 handler は
 * 再 AssumeRole して送るだけにする (= re-lookup 不要、 注入時の決定を凍結)。
 *
 * - name は `EXEC#` と対の冪等キー (= 同 requestId/teamId の重複 fire で同名 → CreateSchedule が衝突を弾く)。
 * - FlexibleTimeWindow=OFF / ActionAfterCompletion=DELETE (= 発火後に自動削除、 schedule が溜まらない)。
 * - schedule が target を起動するための RoleArn は construct が作り env 経由で注入 (= deps.schedulerRoleArn)。
 *
 * SDK error は握り潰さず伝播し、必須の自動復旧予約に失敗したことを明示する。
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
  /** schedule が呼び戻す target (= executor Lambda 自身) の ARN。 revert / inject 共通。 */
  readonly revertTargetArn: string;
}

const MAX_SCHEDULE_NAME = 64;

/** 秒 → ミリ秒 の換算係数 (schedule 時刻計算用)。 */
const MS_PER_SECOND = 1000;
/** 分 → 秒 の換算係数 (schedule 時刻計算用)。 */
const SECONDS_PER_MINUTE = 60;
/** 分 → ミリ秒 の換算係数 (= 60000ms。 schedule 時刻計算用)。 */
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;

function sanitizeScheduleName(raw: string): string {
  return raw.replace(/[^0-9A-Za-z\-_.]/g, "-").slice(0, MAX_SCHEDULE_NAME);
}

/** `EXEC#{requestId}#{teamId}` と対の冪等な schedule 名。 aws-scheduler の name 制約に sanitize。 */
export function revertScheduleName(detail: DisruptionFiredDetail): string {
  return sanitizeScheduleName(`tc-revert-${detail.requestId}-${detail.teamId}`);
}

/** scheduled fire の遅延注入 schedule 名。 revert と対の冪等キー (requestId/teamId)。 */
export function injectScheduleName(detail: DisruptionFiredDetail): string {
  return sanitizeScheduleName(`tc-inject-${detail.requestId}-${detail.teamId}`);
}

/**
 * recurring fire の rate schedule 名を `(requestId, teamId)` から直接組む。 executor 側の
 * 作成と、 event-handler 側の cancel (DeleteSchedule) が **同一の名前** を導けるよう primitive を共有する
 * (= cancel が確実に同じ schedule を消せる)。
 */
export function recurringScheduleNameOf(requestId: string, teamId: string): string {
  return sanitizeScheduleName(`tc-recur-${requestId}-${teamId}`);
}

/** recurring fire の rate schedule 名。 requestId/teamId と対の冪等キー (cancel/teardown 用)。 */
export function recurringScheduleName(detail: DisruptionFiredDetail): string {
  return recurringScheduleNameOf(detail.requestId, detail.teamId);
}

/**
 * aws-scheduler が各 tick で実 ISO 時刻に置換する universal target template 変数。 recurring の
 * tick payload の `firedAt` にこれを入れることで、 executor 側 per-tick claim
 * (`EXEC#{requestId}#{teamId}#RECUR#{firedAt}`) が tick ごとに一意になり二重採点を防ぐ。
 */
const SCHEDULED_TIME_TEMPLATE = "<aws.scheduler.scheduled-time>";

/** base 時刻 + afterSeconds の UTC を ISO と aws-scheduler の `at(...)` 式 (秒精度) で返す。 */
function oneShotAt(baseIso: string, afterSeconds: number): { iso: string; expression: string } {
  const at = new Date(new Date(baseIso).getTime() + afterSeconds * MS_PER_SECOND);
  const iso = at.toISOString();
  return { iso, expression: `at(${iso.slice(0, 19)})` };
}

/** firedAt + afterSeconds の UTC 時刻を aws-scheduler の `at(...)` 式 (秒精度) に。 */
export function revertAtExpression(firedAtIso: string, afterSeconds: number): string {
  return oneShotAt(firedAtIso, afterSeconds).expression;
}

/**
 * executor 自身を呼び戻す one-shot schedule を 1 件登録する (= revert / inject 共通)。
 * FlexibleTimeWindow=OFF / ActionAfterCompletion=DELETE (= 発火後に自動削除、 schedule が溜まらない)。
 * SDK error は握り潰さず伝播し、必須の自動復旧予約に失敗したことを明示する。
 */
function sendOneShot(
  deps: ScheduleRevertDeps,
  name: string,
  expression: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return deps.scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      State: ScheduleState.ENABLED,
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Target: {
        Arn: deps.revertTargetArn,
        RoleArn: deps.schedulerRoleArn,
        Input: JSON.stringify(input),
      },
    }),
  );
}

export async function scheduleRevert(
  revert: DisruptionDispatch,
  detail: DisruptionFiredDetail,
  target: DeploymentTarget,
  afterSeconds: number,
  deps: ScheduleRevertDeps,
): Promise<void> {
  await sendOneShot(
    deps,
    revertScheduleName(detail),
    revertAtExpression(detail.firedAt, afterSeconds),
    {
      mode: "revert",
      detail,
      dispatch: revert,
      target,
    },
  );
}

/**
 * scheduled fire: 注入を `afterMinutes` 分後に予約する。 schedule は executor を
 * `{mode:"inject", detail}` payload で呼び戻す。 payload の `detail.firedAt` は注入予定時刻に
 * 進め、 `afterMinutes` は落とす (= T+N の revert が注入時刻基準になる / 再遅延しない)。
 */
export async function scheduleInject(
  detail: DisruptionFiredDetail,
  afterMinutes: number,
  deps: ScheduleRevertDeps,
): Promise<void> {
  const { iso, expression } = oneShotAt(detail.firedAt, afterMinutes * SECONDS_PER_MINUTE);
  const { afterMinutes: _drop, ...rest } = detail;
  const injectDetail: DisruptionFiredDetail = { ...rest, firedAt: iso };
  await sendOneShot(deps, injectScheduleName(detail), expression, {
    mode: "inject",
    detail: injectDetail,
  });
}

/**
 * recurring fire: `rate(intervalMinutes minutes)` schedule を 1 件登録し、 各 tick で
 * executor を `{mode:"inject-recurring", detail}` で呼び戻す。 `EndDate = firedAt + interval*maxFires`
 * + `ActionAfterCompletion: DELETE` で maxFires 回ぶん経過後に aws-scheduler が停止 + 自動削除する
 * (= always-ends、 IAM 追加不要・DDB カウンタ不要)。 tick payload の `firedAt` は scheduled-time
 * template に置換させ、 executor の per-tick claim (`...#RECUR#{firedAt}`) を tick ごとに一意化する。
 */
export async function scheduleRecurring(
  detail: DisruptionFiredDetail,
  intervalMinutes: number,
  maxFires: number,
  deps: ScheduleRevertDeps,
): Promise<void> {
  const start = new Date(detail.firedAt);
  const end = new Date(start.getTime() + intervalMinutes * maxFires * MS_PER_MINUTE);
  const { recurrence: _r, afterMinutes: _a, ...rest } = detail;
  const tickDetail: DisruptionFiredDetail = { ...rest, firedAt: SCHEDULED_TIME_TEMPLATE };
  await deps.scheduler.send(
    new CreateScheduleCommand({
      Name: recurringScheduleName(detail),
      ScheduleExpression: `rate(${intervalMinutes} minutes)`,
      ScheduleExpressionTimezone: "UTC",
      StartDate: start,
      EndDate: end,
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      State: ScheduleState.ENABLED,
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Target: {
        Arn: deps.revertTargetArn,
        RoleArn: deps.schedulerRoleArn,
        Input: JSON.stringify({ mode: "inject-recurring", detail: tickDetail }),
      },
    }),
  );
}
