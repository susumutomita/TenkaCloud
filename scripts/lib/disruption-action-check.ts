/**
 * [ADR-031 / Issue #1419] disruptions[].action (cross-account 障害注入の宣言) の契約を機械 enforce する。
 *
 *   - kind は allow-list (ssm-run-command / lambda-invoke / cfn-stack-update) 内
 *   - targetRef (= 注入対象を解決する stackOutputs key) は非空 string
 *   - revert 必須 + afterSeconds は 0 < x <= 24h (ADR-029 INV-2「いかなる disruption も永続しない」を宣言時に保証)
 *   - paramTemplate / revert.paramTemplate の `{{key}}` placeholder は parameters / operatorEditable で
 *     宣言済の key しか参照できない (= operator / 出題者が任意値を競技者アカウントの API へ流す injection 面を縮小)
 *
 * action 未宣言の disruption は Phase A (監査のみ) のままで無影響 (= 後方互換)。
 *
 * validate-problems.ts から切り出した独立 module (= SRP / file-too-large 回避)。
 */

type Metadata = Record<string, unknown>;
type ValidationError = string;

const DISRUPTION_ACTION_KINDS = new Set(["ssm-run-command", "lambda-invoke", "cfn-stack-update"]);
const MAX_REVERT_AFTER_SECONDS = 24 * 60 * 60;
const ACTION_PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function collectActionStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectActionStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectActionStrings(v, out);
  }
}

function declaredPlaceholderKeys(d: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const params = d.parameters;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const k of Object.keys(params)) keys.add(k);
  }
  if (Array.isArray(d.operatorEditable)) {
    for (const k of d.operatorEditable) if (typeof k === "string") keys.add(k);
  }
  return keys;
}

function checkActionRevert(id: string, revert: unknown): ValidationError[] {
  if (!revert || typeof revert !== "object" || Array.isArray(revert)) {
    return [
      `disruptions[id=${id}].action.revert is required (ADR-029 INV-2: no disruption may be permanent)`,
    ];
  }
  const afterSeconds = (revert as { afterSeconds?: unknown }).afterSeconds;
  if (typeof afterSeconds !== "number" || !Number.isFinite(afterSeconds) || afterSeconds <= 0) {
    return [
      `disruptions[id=${id}].action.revert.afterSeconds must be a positive number of seconds`,
    ];
  }
  if (afterSeconds > MAX_REVERT_AFTER_SECONDS) {
    return [
      `disruptions[id=${id}].action.revert.afterSeconds=${afterSeconds} exceeds the ${MAX_REVERT_AFTER_SECONDS}s cap (ADR-029 INV-2)`,
    ];
  }
  return [];
}

function checkActionPlaceholders(
  id: string,
  action: Record<string, unknown>,
  d: Record<string, unknown>,
): ValidationError[] {
  const declared = declaredPlaceholderKeys(d);
  const strings: string[] = [];
  collectActionStrings(action.paramTemplate, strings);
  const revert = action.revert;
  if (revert && typeof revert === "object" && !Array.isArray(revert)) {
    collectActionStrings((revert as Record<string, unknown>).paramTemplate, strings);
  }
  const errors: ValidationError[] = [];
  for (const s of strings) {
    for (const m of s.matchAll(ACTION_PLACEHOLDER_RE)) {
      const key = m[1];
      if (key && !declared.has(key)) {
        errors.push(
          `disruptions[id=${id}].action references undeclared placeholder {{${key}}} (allow only parameters / operatorEditable keys)`,
        );
      }
    }
  }
  return errors;
}

function checkSingleDisruptionAction(
  id: string,
  d: Record<string, unknown>,
  action: unknown,
): ValidationError[] {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return [`disruptions[id=${id}].action must be an object`];
  }
  const a = action as Record<string, unknown>;
  const errors: ValidationError[] = [];
  if (typeof a.kind !== "string" || !DISRUPTION_ACTION_KINDS.has(a.kind)) {
    errors.push(
      `disruptions[id=${id}].action.kind must be one of ssm-run-command | lambda-invoke | cfn-stack-update`,
    );
  }
  if (typeof a.targetRef !== "string" || a.targetRef === "") {
    errors.push(`disruptions[id=${id}].action.targetRef (stackOutputs key) is required`);
  }
  errors.push(...checkActionRevert(id, a.revert));
  errors.push(...checkActionPlaceholders(id, a, d));
  return errors;
}

export function checkDisruptionActions(meta: Metadata): ValidationError[] {
  const disruptions = Array.isArray(meta.disruptions) ? meta.disruptions : [];
  const errors: ValidationError[] = [];
  for (const raw of disruptions as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object" || raw.action === undefined) continue;
    const id = typeof raw.id === "string" ? raw.id : "?";
    errors.push(...checkSingleDisruptionAction(id, raw, raw.action));
  }
  return errors;
}

/**
 * [ADR-031] action.targetRef / functionRef は team の stackOutputs (= CFn Output) key を指す。
 * executable runtime のときだけ template.yaml の Outputs に実在するかを cross-ref する
 * (scoring.flagOutputKey / endpoints[].default.key と同方針)。
 */
export function checkDisruptionActionOutputRefs(
  meta: Metadata,
  yaml: string,
  cfnTemplate: string,
): ValidationError[] {
  const disruptions = Array.isArray(meta.disruptions) ? meta.disruptions : [];
  const errors: ValidationError[] = [];
  for (const raw of disruptions as Array<Record<string, unknown>>) {
    const action = raw?.action as Record<string, unknown> | undefined;
    if (!action || typeof action !== "object" || Array.isArray(action)) continue;
    const id = typeof raw.id === "string" ? raw.id : "?";
    for (const field of ["targetRef", "functionRef"] as const) {
      const ref = action[field];
      if (typeof ref === "string" && ref !== "" && !yaml.includes(`${ref}:`)) {
        errors.push(
          `disruptions[id=${id}].action.${field}="${ref}" not found in ${cfnTemplate} Outputs (= executor が注入対象を解決できない)`,
        );
      }
    }
  }
  return errors;
}
