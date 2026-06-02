/**
 * [ADR-031 / Issue #1419] executor Lambda の invocation router (= handler entry の純粋ロジック)。
 *
 * 同じ executor Lambda が 2 経路で起動される:
 *   1. EventBridge `*DisruptionFired` rule → `{ ..., detail: DisruptionFiredDetail }` envelope (= 注入)
 *   2. aws-scheduler の one-shot → `{ mode: "revert", dispatch, target }` payload (= 復旧、 scheduleRevert が積む)
 *
 * router は両者を判別し、 注入は `executeDisruptionAction`、 復旧は `sendDispatch` dep をそのまま再利用する
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
} from "./execute.js";

interface RevertInvocation {
  readonly mode: "revert";
  readonly dispatch: DisruptionDispatch;
  readonly target: DeploymentTarget;
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
  return {
    disruptionId,
    eventId,
    problemId,
    tenantId,
    teamId,
    requestId,
    firedAt,
    parameters: isObject(d.parameters) ? d.parameters : {},
  };
}

function isRevertInvocation(event: unknown): event is RevertInvocation {
  return (
    isObject(event) && event.mode === "revert" && isObject(event.dispatch) && isObject(event.target)
  );
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
  const detail = parseDisruptionFiredDetail(event);
  if (!detail) return { kind: "invalid_event" };
  return executeDisruptionAction(detail, deps);
}
