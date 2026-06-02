/**
 * [ADR-031 / Issue #1419] cross-account disruption executor の orchestration。
 *
 * `*DisruptionFired` event (= disruption-fire が operator account の bus に publish したもの) を 1 件受け、
 * 該当 team の deployment へ実障害を注入し、 ADR-029 INV-2 のため復旧を予約する。 流れ:
 *
 *   1. catalog で `(problemId, disruptionId)` の `action` を解決。 action 未宣言 = Phase A (監査のみ) で no-op。
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
}

/** 注入対象 team deployment の解決結果。 */
export interface DeploymentTarget {
  readonly jobId: string;
  readonly region: string;
  readonly competitorRoleArn: string;
  readonly externalIdParameterName: string;
  /** CFn Outputs (= deployment row の stackOutputs JSON を parse 済)。 */
  readonly stackOutputs: Readonly<Record<string, string>>;
}

export interface ExecutorDeps {
  /** problemsDisruptions catalog (= fire と同じ env 由来)。 */
  readonly problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>;
  /** `EXEC#{requestId}#{teamId}` の conditional claim。 claimed=winner / duplicate=既処理。 */
  readonly claimExecution: (detail: DisruptionFiredDetail) => Promise<"claimed" | "duplicate">;
  /** team+problem deployment を解決。 未 deploy / 未完了 / stackOutputs 無しは undefined。 */
  readonly resolveDeployment: (
    detail: DisruptionFiredDetail,
  ) => Promise<DeploymentTarget | undefined>;
  /** dispatch を競技者アカウントで実行 (= AssumeRole + SDK send は具体実装側)。 */
  readonly sendDispatch: (dispatch: DisruptionDispatch, target: DeploymentTarget) => Promise<void>;
  /** revert を afterSeconds 後に予約 (ADR-029 INV-2)。 scheduler 機構は具体実装側。 */
  readonly scheduleRevert: (
    dispatch: DisruptionDispatch,
    target: DeploymentTarget,
    afterSeconds: number,
  ) => Promise<void>;
}

export type DisruptionExecuteOutcome =
  | { readonly kind: "ok"; readonly jobId: string }
  | { readonly kind: "no_action" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unknown_disruption" }
  | { readonly kind: "no_deployment" };

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
 * 1 件の fired disruption を実行する。 副作用は deps 経由のみ。 戻り値で結果を表す
 * (= caller の handler が log / metric に使う)。
 */
export async function executeDisruptionAction(
  detail: DisruptionFiredDetail,
  deps: ExecutorDeps,
): Promise<DisruptionExecuteOutcome> {
  const action = resolveAction(deps.problemsDisruptions, detail.problemId, detail.disruptionId);
  if (action === "unknown") return { kind: "unknown_disruption" };
  // action 未宣言 = Phase A 監査のみ。 注入は起こさない (= 後方互換)。
  if (!action) return { kind: "no_action" };

  // EventBridge at-least-once の再配送を per-team 冪等で弾く。 claim は注入の前に取る。
  if ((await deps.claimExecution(detail)) === "duplicate") return { kind: "duplicate" };

  const target = await deps.resolveDeployment(detail);
  if (!target) return { kind: "no_deployment" };

  const inject = buildDisruptionDispatch(action, detail.parameters, target.stackOutputs);
  await deps.sendDispatch(inject, target);

  // ADR-029 INV-2: 注入したら必ず復旧を予約する (revert は schema 必須)。
  const revert = buildRevertDispatch(action, detail.parameters, target.stackOutputs);
  await deps.scheduleRevert(revert, target, action.revert.afterSeconds);

  return { kind: "ok", jobId: target.jobId };
}
