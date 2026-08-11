/**
 * [Issue #1419] cross-account disruption executor の orchestration。
 *
 * `*DisruptionFired` event (= disruption-fire が operator account の bus に publish したもの) を 1 件受け、
 * 該当 team の deployment へ実障害を注入し、注入後は必ず自動復旧を予約する。流れ:
 *
 *   1. catalog で `(problemId, disruptionId)` の `action` を解決。action 未宣言は監査のみで no-op。
 *   2. `EXEC#{requestId}#{teamId}` の conditional claim で per-team 冪等性を取る (= EventBridge at-least-once 対策)。
 *   3. team の deployment row (jobId / region / competitorRoleArn / externalId / stackOutputs) を解決。
 *      未 deploy / 未完了 = 注入対象が無いので no-op (loud にせず skip、 監査は claim 済)。
 *   4. competitor account へ AssumeRole (ExternalId) し、 inject dispatch を送る。
 *   5. revert dispatch を `afterSeconds` 後に予約 (= 必ず復旧する。 永続障害の禁止)。
 *
 * I/O 境界 (catalog 解決 / 冪等 claim / deployment 解決 / AssumeRole / 送信 / 予約) はすべて deps として注入し、
 * 本 orchestration は **判断 (順序 / 分岐) だけ** を持つ純粋な関数にする (= describe-stack-handler と同じ DI 方針、
 * unit test で全分岐を mock で pin できる)。 各 dep の具体実装 (SDK mapping / scheduler / DDB query) と
 * Lambda + IAM の CDK 配線は、 競技者アカウントへ実 fault を deploy する判断を伴うため別途。
 */

import type {
  DisruptionAction,
  ProblemDisruptionEntry,
} from "../../../utils/discover-problems-catalog.js";
import {
  buildDisruptionDispatch,
  buildRevertDispatch,
  type DisruptionDispatch,
} from "./dispatch-command.js";

/** fired event の Detail (= disruption-fire.publishEntries が JSON.stringify する形)。 */
export interface DisruptionFiredDetail {
  readonly disruptionId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly firedAt: string;
  /**
   * scheduled fire の遅延分。 未指定 / 0 は即時注入。 1 以上なら executor が
   * `afterMinutes` 分後に注入を遅延予約する (= mode:"inject" で自分を呼び戻す)。
   */
  readonly afterMinutes?: number;
  /**
   * recurring fire。 宣言されると executor は `rate(intervalMinutes)` schedule を 1 件作り、
   * `maxFires` 回ぶん (= EndDate) 経過後に aws-scheduler が自動停止する。 tick payload には乗せない
   * (= 各 tick は単発 inject)。
   */
  readonly recurrence?: { readonly intervalMinutes: number; readonly maxFires: number };
}

/** 注入対象 team deployment の解決結果。 */
export interface DeploymentTarget {
  readonly jobId: string;
  readonly region: string;
  /**
   * cross-account (SaaS) deploy の競技者ロール ARN。 Lite mode (= same-account) では未設定 (#1710)。
   * 未設定なら executor は AssumeRole せず Lambda 自身の credentials で同一アカウントへ注入する。
   */
  readonly competitorRoleArn?: string;
  /** cross-account deploy の ExternalId SSM パラメータ名。 Lite mode では未設定 (#1710)。 */
  readonly externalIdParameterName?: string;
  /** CFn Outputs (= deployment row の stackOutputs JSON を parse 済)。 */
  readonly stackOutputs: Readonly<Record<string, string>>;
}

export interface ExecutorDeps {
  /** problemsDisruptions catalog (= fire と同じ env 由来)。 */
  readonly problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>;
  /**
   * `EXEC#{requestId}#{teamId}` の conditional claim。 claimed=winner / duplicate=既処理。
   * phase="inject" は遅延注入用の別 claim key (scheduler 再配送の二重注入を弾く)。
   */
  readonly claimExecution: (
    detail: DisruptionFiredDetail,
    phase?: "event" | "inject" | "recurring",
  ) => Promise<"claimed" | "duplicate">;
  /** team+problem deployment を解決。 未 deploy / 未完了 / stackOutputs 無しは undefined。 */
  readonly resolveDeployment: (
    detail: DisruptionFiredDetail,
  ) => Promise<DeploymentTarget | undefined>;
  /** dispatch を競技者アカウントで実行 (= AssumeRole + SDK send は具体実装側)。 */
  readonly sendDispatch: (dispatch: DisruptionDispatch, target: DeploymentTarget) => Promise<void>;
  /**
   * revert を afterSeconds 後に予約。 scheduler 機構は具体実装側。
   * `detail` は冪等な schedule 名 (= EXEC# と対の requestId/teamId) と revert invocation payload の
   * 組み立てに必要なため渡す (= 具体実装 scheduleRevert がそれらを使う)。
   */
  readonly scheduleRevert: (
    detail: DisruptionFiredDetail,
    dispatch: DisruptionDispatch,
    target: DeploymentTarget,
    afterSeconds: number,
  ) => Promise<void>;
  /**
   * scheduled fire の遅延注入を `afterMinutes` 分後に予約する。 scheduler 機構は
   * 具体実装側 (= scheduleRevert と同じ aws-scheduler one-shot を転用、 payload は mode:"inject")。
   */
  readonly scheduleInject: (detail: DisruptionFiredDetail, afterMinutes: number) => Promise<void>;
  /**
   * recurring fire: `rate(intervalMinutes)` schedule を 1 件作り、 maxFires 回ぶん (EndDate)
   * 経過後に aws-scheduler が自動停止 + 自動削除する。 各 tick は mode:"inject-recurring" で自身を呼び戻す。
   */
  readonly scheduleRecurring: (
    detail: DisruptionFiredDetail,
    intervalMinutes: number,
    maxFires: number,
  ) => Promise<void>;
}

export type DisruptionExecuteOutcome =
  | { readonly kind: "ok"; readonly jobId: string }
  | { readonly kind: "no_action" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unknown_disruption" }
  | { readonly kind: "no_deployment" }
  | { readonly kind: "scheduled" };

function resolveAction(
  catalog: ExecutorDeps["problemsDisruptions"],
  problemId: string,
  disruptionId: string,
): DisruptionAction | undefined | "unknown" {
  const entries = catalog[problemId];
  if (!entries) return "unknown";
  const declaration = entries.find((d) => d.id === disruptionId);
  if (!declaration) return "unknown";
  return declaration.action;
}

/**
 * deployment を解決し、 inject dispatch を送って revert を予約する (= 即時注入の本体)。
 * 即時 fire と scheduled fire の T+N 遅延注入で共有する (= claim 有無のみが両者の違い)。
 */
async function injectAndScheduleRevert(
  detail: DisruptionFiredDetail,
  action: DisruptionAction,
  deps: ExecutorDeps,
): Promise<DisruptionExecuteOutcome> {
  const target = await deps.resolveDeployment(detail);
  if (!target) return { kind: "no_deployment" };

  const inject = buildDisruptionDispatch(action, detail.parameters, target.stackOutputs);
  await deps.sendDispatch(inject, target);

  // 注入したら必ず復旧を予約する (revert は schema 必須)。
  const revert = buildRevertDispatch(action, detail.parameters, target.stackOutputs);
  await deps.scheduleRevert(detail, revert, target, action.revert.afterSeconds);

  return { kind: "ok", jobId: target.jobId };
}

/**
 * 1 件の fired disruption を実行する。 副作用は deps 経由のみ。 戻り値で結果を表す
 * (= caller の handler が log / metric に使う)。
 *
 * `afterMinutes > 0` の scheduled fire は、 claim を取った上で注入を T+N に遅延予約し
 * `scheduled` を返す (= 注入本体は T+N の {@link executeScheduledInject} で走る)。 claim は fired
 * event 受信時に取るので、 EventBridge at-least-once の再配送は遅延予約より前に弾かれる。
 */
export async function executeDisruptionAction(
  detail: DisruptionFiredDetail,
  deps: ExecutorDeps,
): Promise<DisruptionExecuteOutcome> {
  const action = resolveAction(deps.problemsDisruptions, detail.problemId, detail.disruptionId);
  if (action === "unknown") return { kind: "unknown_disruption" };
  // action 未宣言は監査のみ。注入は起こさない (= 後方互換)。
  if (!action) return { kind: "no_action" };

  // EventBridge at-least-once の再配送を per-team 冪等で弾く。 claim は注入 / 遅延予約の前に取る。
  if ((await deps.claimExecution(detail)) === "duplicate") return { kind: "duplicate" };

  // recurring fire: rate schedule を 1 件作って return (各 tick は executeRecurringInject)。
  // afterMinutes より先に判定する (= 両者は schema で排他なので順序は安全側の防御)。
  if (detail.recurrence) {
    await deps.scheduleRecurring(
      detail,
      detail.recurrence.intervalMinutes,
      detail.recurrence.maxFires,
    );
    return { kind: "scheduled" };
  }

  // afterMinutes は route で 1..1440 に validate 済 (= 未指定 / 0 は即時)。 正値なら遅延予約。
  if (detail.afterMinutes) {
    await deps.scheduleInject(detail, detail.afterMinutes);
    return { kind: "scheduled" };
  }

  return injectAndScheduleRevert(detail, action, deps);
}

/**
 * scheduled fire の T+N 遅延注入。 scheduler が積んだ `mode:"inject"` payload で起動される。
 * aws-scheduler も at-least-once なので、 注入直前に **inject-phase の claim** を取り、 scheduler の
 * 再配送による二重注入を弾く (= 即時 path が同一 invocation の event-phase claim で得るのと同じ冪等保証を、
 * fired event と別経路で届く遅延注入にも与える)。 fired event 時の event-phase claim とは別 key。
 */
export async function executeScheduledInject(
  detail: DisruptionFiredDetail,
  deps: ExecutorDeps,
): Promise<DisruptionExecuteOutcome> {
  const action = resolveAction(deps.problemsDisruptions, detail.problemId, detail.disruptionId);
  if (action === "unknown") return { kind: "unknown_disruption" };
  if (!action) return { kind: "no_action" };
  if ((await deps.claimExecution(detail, "inject")) === "duplicate") return { kind: "duplicate" };
  return injectAndScheduleRevert(detail, action, deps);
}

/**
 * recurring fire の各 tick の注入。 rate schedule が積んだ `{mode:"inject-recurring", detail}`
 * で起動される。 `detail.firedAt` は aws-scheduler が tick ごとに実時刻へ置換するので、 per-tick claim
 * (phase="recurring", key に firedAt を含む) が tick ごとに一意になり、 同一 tick の再配送のみ弾く
 * (= tick 間は別注入として通す)。 各 tick は単発 fire と同じく inject + revert 予約を行う。
 */
export async function executeRecurringInject(
  detail: DisruptionFiredDetail,
  deps: ExecutorDeps,
): Promise<DisruptionExecuteOutcome> {
  const action = resolveAction(deps.problemsDisruptions, detail.problemId, detail.disruptionId);
  if (action === "unknown") return { kind: "unknown_disruption" };
  if (!action) return { kind: "no_action" };
  if ((await deps.claimExecution(detail, "recurring")) === "duplicate")
    return { kind: "duplicate" };
  return injectAndScheduleRevert(detail, action, deps);
}
