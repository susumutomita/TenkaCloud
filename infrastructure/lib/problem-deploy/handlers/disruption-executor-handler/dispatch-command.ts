/**
 * [Issue #1419] cross-account disruption executor の **純粋な dispatch core**。
 *
 * fired event (= `*DisruptionFired`) が持つ `action` 宣言 + 既に fold 済の `parameters` +
 * team の `stackOutputs` を受け取り、 競技者アカウントで実行すべき 1 アクションを **SDK 非依存の
 * 正規化記述子** に落とす。 ここでは AWS を一切呼ばない (= AssumeRole / SendCommand 等は handler の
 * 責務)。 純関数なので unit test で全分岐を pin できる。
 *
 * 設計判断:
 *   - `targetRef` / `functionRef` は **stackOutputs の key** からのみ解決する (= 任意 resource id を
 * 直接実行させない、 injection 縮小)。 解決できなければ loud に throw (silent fallback 禁止)。
 *   - `paramTemplate` の `{{key}}` は fired `parameters` の値でのみ置換する。 値が無い placeholder は
 *     literal `{{key}}` を競技者アカウントへ送らないよう throw する (= validate-problems の宣言時 allow-list と
 *     runtime の二重防御)。
 *   - revert は注入と同じ kind / target を使い、 `action.revert` の documentName / paramTemplate で
 *     上書きする。 `afterSeconds` は scheduling metadata なので記述子には含めない (handler が scheduler に渡す)。
 */

import type {
  DisruptionAction,
  DisruptionActionKind,
} from "../../../utils/discover-problems-catalog.js";

/** 競技者アカウントで実行する 1 アクションの正規化記述子 (SDK 非依存)。 */
export interface DisruptionDispatch {
  readonly kind: DisruptionActionKind;
  /** 解決済の実行対象 (= ssm: instance ids 文字列 / lambda: function 名 ARN / cfn: stack 名)。 */
  readonly target: string;
  /** ssm-run-command の SSM Document 名 (他 kind では undefined)。 */
  readonly documentName?: string;
  /** placeholder 置換済の API 引数 (= SSM Parameters / Lambda payload / CFn Parameters の素材)。 */
  readonly params: Record<string, unknown>;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function substituteString(value: string, params: Readonly<Record<string, unknown>>): string {
  return value.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (!(key in params)) {
      throw new Error(
        `disruption action placeholder {{${key}}} has no value in the fired parameters`,
      );
    }
    return String(params[key]);
  });
}

/** paramTemplate を再帰的に walk して string 中の `{{key}}` を fired parameters で置換する。 */
function substituteValue(value: unknown, params: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === "string") return substituteString(value, params);
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteValue(v, params);
    return out;
  }
  return value;
}

function substituteTemplate(
  template: Readonly<Record<string, unknown>> | undefined,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!template) return {};
  return substituteValue(template, params) as Record<string, unknown>;
}

/** stackOutputs[ref] を解決する。 未宣言 / 空は loud に throw (= 注入対象が無いのに送らない)。 */
function resolveOutput(
  ref: string,
  stackOutputs: Readonly<Record<string, string>>,
  label: string,
): string {
  const value = stackOutputs[ref];
  if (typeof value !== "string" || value === "") {
    throw new Error(`disruption action ${label}="${ref}" not found in team stackOutputs`);
  }
  return value;
}

/**
 * 注入アクションの記述子を組み立てる。 lambda-invoke は `functionRef ?? targetRef` を、 それ以外は
 * `targetRef` を stackOutputs から解決する。
 */
export function buildDisruptionDispatch(
  action: DisruptionAction,
  parameters: Readonly<Record<string, unknown>>,
  stackOutputs: Readonly<Record<string, string>>,
): DisruptionDispatch {
  const targetRef =
    action.kind === "lambda-invoke" ? (action.functionRef ?? action.targetRef) : action.targetRef;
  const target = resolveOutput(
    targetRef,
    stackOutputs,
    action.kind === "lambda-invoke" ? "functionRef/targetRef" : "targetRef",
  );
  return {
    kind: action.kind,
    target,
    ...(action.documentName ? { documentName: action.documentName } : {}),
    params: substituteTemplate(action.paramTemplate, parameters),
  };
}

/**
 * 復旧アクションの記述子。 注入と同じ kind / target を使い、 `action.revert` の documentName /
 * paramTemplate で上書きする。 `afterSeconds` は記述子に含めない (= handler が scheduler に渡す)。
 */
export function buildRevertDispatch(
  action: DisruptionAction,
  parameters: Readonly<Record<string, unknown>>,
  stackOutputs: Readonly<Record<string, string>>,
): DisruptionDispatch {
  const injected = buildDisruptionDispatch(action, parameters, stackOutputs);
  const revert = action.revert;
  return {
    kind: injected.kind,
    target: injected.target,
    ...(revert.documentName
      ? { documentName: revert.documentName }
      : injected.documentName
        ? { documentName: injected.documentName }
        : {}),
    params: substituteTemplate(revert.paramTemplate, parameters),
  };
}
