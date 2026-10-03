/**
 * [Issue #1419] executor Lambda の invocation router (handler entry の純粋ロジック)。
 *
 * 同じ executor Lambda が 3 経路で起動される:
 *   1. EventBridge `*DisruptionFired` rule → `{ ..., detail: DisruptionFiredDetail }` envelope (= 注入)
 *   2. aws-scheduler の one-shot → `{ mode: "revert", dispatch, target }` payload (= 復旧、 scheduleRevert が積む)
 * 3. aws-scheduler の one-shot → `{ mode: "inject", detail }` payload (scheduled fire の T+N 遅延注入、 scheduleInject が積む)
 *
 * router は 3 者を判別する。 注入 (1) は `executeDisruptionAction` (claim 込)、 遅延注入 (3) は
 * `executeScheduledInject` (claim 済なので再取得しない)、 復旧 (2) は `sendDispatch` dep を再利用する
 * (= revert の credentials は wired sendDispatch dep が target から都度 AssumeRole する前提なので、 inject と
 * 同じ dep で送れる)。 不正 envelope は `invalid_event` (= loud に落とさず handler が log/metric にできる形)。
 *
 * 実 client / AssumeRole の組み立ては index.ts (= 別途、 deploy 判断を伴う) が deps として注入する。
 * 本 module は純粋で、 unit test で全分岐を mock で pin できる。
 */

import type { DisruptionDispatch } from "./dispatch-command.js";
import {
  type DeploymentTarget,
  type DisruptionExecuteOutcome,
  type DisruptionFiredDetail,
  type ExecutorDeps,
  executeDisruptionAction,
  executeRecurringInject,
  executeScheduledInject,
} from "./execute.js";

interface RevertInvocation {
  readonly mode: "revert";
  readonly dispatch: DisruptionDispatch;
  readonly target: DeploymentTarget;
}

interface InjectInvocation {
  readonly mode: "inject";
  readonly detail: Record<string, unknown>;
}

interface InjectRecurringInvocation {
  readonly mode: "inject-recurring";
  readonly detail: Record<string, unknown>;
}

export type RouteOutcome =
  | DisruptionExecuteOutcome
  | { readonly kind: "reverted" }
  | { readonly kind: "invalid_event" };

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** EventBridge envelope の `detail` を DisruptionFiredDetail へ narrow。 必須 string 欠落は undefined。 */
export function parseDisruptionFiredDetail(event: unknown): DisruptionFiredDetail | undefined {
  if (!isObject(event) || !isObject(event.detail)) return undefined;
  const d = event.detail;
  const disruptionId = asNonEmptyString(d.disruptionId);
  const eventId = asNonEmptyString(d.eventId);
  const problemId = asNonEmptyString(d.problemId);
  const tenantId = asNonEmptyString(d.tenantId);
  const teamId = asNonEmptyString(d.teamId);
  const requestId = asNonEmptyString(d.requestId);
  const firedAt = asNonEmptyString(d.firedAt);
  if (!disruptionId || !eventId || !problemId || !tenantId || !teamId || !requestId || !firedAt) {
    return undefined;
  }
  // scheduled fire の遅延分。 正の有限数だけ採用 (それ以外は即時注入扱い)。
  const afterMinutes =
    typeof d.afterMinutes === "number" && Number.isFinite(d.afterMinutes) && d.afterMinutes > 0
      ? d.afterMinutes
      : undefined;
  // recurring fire の宣言 (initial fired event のみ持つ)。 両 field が正の有限数のときだけ採用。
  const recurrence = parsePositivePair(d.recurrence, "intervalMinutes", "maxFires");
  return {
    disruptionId,
    eventId,
    problemId,
    tenantId,
    teamId,
    requestId,
    firedAt,
    parameters: isObject(d.parameters) ? d.parameters : {},
    ...(afterMinutes !== undefined ? { afterMinutes } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
  };
}

/** `{[a]:number>0, [b]:number>0}` を narrow。 どちらか欠落/非正なら undefined (= recurring 扱いしない)。 */
function parsePositivePair<A extends string, B extends string>(
  value: unknown,
  a: A,
  b: B,
): { readonly [K in A | B]: number } | undefined {
  if (!isObject(value)) return undefined;
  const va = value[a];
  const vb = value[b];
  if (typeof va !== "number" || !Number.isFinite(va) || va <= 0) return undefined;
  if (typeof vb !== "number" || !Number.isFinite(vb) || vb <= 0) return undefined;
  return { [a]: va, [b]: vb } as { readonly [K in A | B]: number };
}

function isRevertInvocation(event: unknown): event is RevertInvocation {
  return (
    isObject(event) && event.mode === "revert" && isObject(event.dispatch) && isObject(event.target)
  );
}

function isInjectInvocation(event: unknown): event is InjectInvocation {
  return isObject(event) && event.mode === "inject" && isObject(event.detail);
}

function isInjectRecurringInvocation(event: unknown): event is InjectRecurringInvocation {
  return isObject(event) && event.mode === "inject-recurring" && isObject(event.detail);
}

/** executor Lambda の 1 invocation を inject / revert に振り分けて実行する。 */
export async function routeDisruptionInvocation(
  event: unknown,
  deps: ExecutorDeps,
): Promise<RouteOutcome> {
  if (isRevertInvocation(event)) {
    // revert: scheduleRevert が積んだ構築済 dispatch を、 inject と同じ sendDispatch dep で送る
    // (= dep が target から都度 AssumeRole する。 注入時 creds は永続しない)。
    await deps.sendDispatch(event.dispatch, event.target);
    return { kind: "reverted" };
  }
  if (isInjectInvocation(event)) {
    // scheduled fire の T+N 遅延注入: scheduleInject が積んだ {mode:"inject", detail} を
    // 注入本体 (claim 済) として実行する。 detail の narrow は fired event と同じ parser を再利用。
    const detail = parseDisruptionFiredDetail(event);
    if (!detail) return { kind: "invalid_event" };
    return executeScheduledInject(detail, deps);
  }
  if (isInjectRecurringInvocation(event)) {
    // recurring fire の各 tick: rate schedule が積んだ {mode:"inject-recurring", detail}。
    // detail.firedAt は aws-scheduler が tick 実時刻に置換済 → per-tick claim が一意になる。
    const detail = parseDisruptionFiredDetail(event);
    if (!detail) return { kind: "invalid_event" };
    return executeRecurringInject(detail, deps);
  }
  const detail = parseDisruptionFiredDetail(event);
  if (!detail) return { kind: "invalid_event" };
  return executeDisruptionAction(detail, deps);
}
