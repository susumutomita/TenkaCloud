/**
 * Issue #2106: pure `metadata.json` section
 * parsers for `phases[]` and `disruptions[]` — single source of truth shared by
 * the platform (CDK synth discovery + Lambda runtime) and external Pack authoring.
 * The infra copy re-exports from here. Every function is pure (no I/O, no env,
 * no clock).
 */

/** One time-based rule-switch declaration of a `phased-polling` problem. */
export interface ProblemPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
  readonly description?: string;
}

/** Issue #1422: condition-triggered disruption firing condition (OR-combined). */
export type DisruptionTrigger =
  | { readonly kind: "after-deploy"; readonly afterMinutes: number }
  | { readonly kind: "team-score-above"; readonly threshold: number }
  | { readonly kind: "phase-entered"; readonly phaseName: string };

/** Issue #1419: cross-account disruption action kind dispatched by the executor. */
export type DisruptionActionKind = "ssm-run-command" | "lambda-invoke" | "cfn-stack-update";

export const DISRUPTION_ACTION_KINDS: readonly DisruptionActionKind[] = [
  "ssm-run-command",
  "lambda-invoke",
  "cfn-stack-update",
];

/** Mandatory revert declaration: no disruption persists. */
export interface DisruptionActionRevert {
  readonly afterSeconds: number;
  readonly documentName?: string;
  readonly paramTemplate?: Readonly<Record<string, unknown>>;
}

/** Issue #1419: declaration of the fault a disruption injects in a competitor account. */
export interface DisruptionAction {
  readonly kind: DisruptionActionKind;
  readonly targetRef: string;
  readonly documentName?: string;
  readonly functionRef?: string;
  readonly paramTemplate?: Readonly<Record<string, unknown>>;
  readonly revert: DisruptionActionRevert;
}

/** Issue #1665: scoring-level effect of a disruption (separate from real fault injection). */
export type DisruptionEffect = {
  readonly kind: "penalty";
  readonly points: number;
  readonly durationSeconds: number;
};

/** Effect duration cap: at most one hour, so no scoring fault can persist indefinitely. */
export const DISRUPTION_EFFECT_MAX_DURATION_SECONDS = 3600;

export interface ProblemDisruptionEntry {
  readonly id: string;
  readonly name: string;
  readonly eventDetailType: string;
  readonly description?: string;
  readonly defaultAfterMinutes?: number;
  readonly operatorEditable?: readonly string[];
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly publicHint?: boolean;
  /** Issue #1422: condition-triggered firing (unset = self-fire only). */
  readonly triggers?: readonly DisruptionTrigger[];
  /** Issue #1419: cross-account execution action (unset = audit only). */
  readonly action?: DisruptionAction;
  /** Issue #1665: scoring-level effect (unset = no effect). */
  readonly effect?: DisruptionEffect;
  /** Recurrence on trigger (unset = fire once). */
  readonly recurrence?: { readonly intervalMinutes: number; readonly maxFires: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow one `phases[]` entry to {@link ProblemPhaseEntry}, or `undefined` when
 * `name` / `afterMinutes` are missing. `effect.switchPlatformToDegraded` keeps
 * only string elements.
 */
export function parsePhaseEntry(value: unknown): ProblemPhaseEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    name?: unknown;
    afterMinutes?: unknown;
    effect?: unknown;
    description?: unknown;
  };
  if (typeof v.name !== "string" || typeof v.afterMinutes !== "number") return undefined;
  const effectInput =
    v.effect && typeof v.effect === "object" ? (v.effect as Record<string, unknown>) : undefined;
  const effect = effectInput
    ? {
        ...(typeof effectInput.scorePathOverride === "string"
          ? { scorePathOverride: effectInput.scorePathOverride }
          : {}),
        ...(Array.isArray(effectInput.switchPlatformToDegraded)
          ? {
              switchPlatformToDegraded: effectInput.switchPlatformToDegraded.filter(
                (s): s is string => typeof s === "string",
              ),
            }
          : {}),
      }
    : undefined;
  return {
    name: v.name,
    afterMinutes: v.afterMinutes,
    ...(effect ? { effect } : {}),
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };
}

/**
 * Extract `disruptions[].effect` fail-safe: only `kind="penalty"` with a positive
 * finite `points` and a positive finite `durationSeconds` within the cap returns;
 * otherwise undefined (no effect). Strict declaration-time checks live elsewhere.
 */
export function parseDisruptionEffect(value: unknown): DisruptionEffect | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.kind !== "penalty") return undefined;
  const points = value.points;
  const durationSeconds = value.durationSeconds;
  if (typeof points !== "number" || !Number.isFinite(points) || points <= 0) return undefined;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > DISRUPTION_EFFECT_MAX_DURATION_SECONDS
  ) {
    return undefined;
  }
  return { kind: "penalty", points, durationSeconds };
}

/**
 * Extract `disruptions[].action` typed: returns only when the executor can run it
 * safely (kind in allow-list, targetRef a non-empty string, revert.afterSeconds
 * positive finite); otherwise undefined (fail-safe to Phase A audit only).
 */
export function parseDisruptionAction(value: unknown): DisruptionAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as {
    kind?: unknown;
    targetRef?: unknown;
    documentName?: unknown;
    functionRef?: unknown;
    paramTemplate?: unknown;
    revert?: unknown;
  };
  if (!isDisruptionActionKind(v.kind) || typeof v.targetRef !== "string" || v.targetRef === "") {
    return undefined;
  }
  const revert = parseDisruptionActionRevert(v.revert);
  if (!revert) return undefined;
  return {
    kind: v.kind,
    targetRef: v.targetRef,
    ...(typeof v.documentName === "string" ? { documentName: v.documentName } : {}),
    ...(typeof v.functionRef === "string" ? { functionRef: v.functionRef } : {}),
    ...(isPlainObject(v.paramTemplate) ? { paramTemplate: v.paramTemplate } : {}),
    revert,
  };
}

function isDisruptionActionKind(value: unknown): value is DisruptionActionKind {
  return (
    typeof value === "string" && DISRUPTION_ACTION_KINDS.includes(value as DisruptionActionKind)
  );
}

function parseDisruptionActionRevert(value: unknown): DisruptionActionRevert | undefined {
  if (!isPlainObject(value)) return undefined;
  const afterSeconds = value.afterSeconds;
  if (typeof afterSeconds !== "number" || !Number.isFinite(afterSeconds) || afterSeconds <= 0) {
    return undefined;
  }
  return {
    afterSeconds,
    ...(typeof value.documentName === "string" ? { documentName: value.documentName } : {}),
    ...(isPlainObject(value.paramTemplate) ? { paramTemplate: value.paramTemplate } : {}),
  };
}

/** Extract `disruptions[].triggers[]` (oneOf) typed; invalid / unknown kinds are dropped. */
export function parseDisruptionTriggers(value: unknown): DisruptionTrigger[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DisruptionTrigger[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as {
      kind?: unknown;
      afterMinutes?: unknown;
      threshold?: unknown;
      phaseName?: unknown;
    };
    if (t.kind === "after-deploy" && typeof t.afterMinutes === "number") {
      out.push({ kind: "after-deploy", afterMinutes: t.afterMinutes });
    } else if (t.kind === "team-score-above" && typeof t.threshold === "number") {
      out.push({ kind: "team-score-above", threshold: t.threshold });
    } else if (t.kind === "phase-entered" && typeof t.phaseName === "string") {
      out.push({ kind: "phase-entered", phaseName: t.phaseName });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Decode the Lambda env (`BATTLE_PROBLEMS_DISRUPTIONS`) JSON back to
 * `{ [problemId]: ProblemDisruptionEntry[] }`. Unset / broken JSON returns {}.
 */
export function parseDisruptionsCatalogEnv(
  raw: string | undefined,
): Record<string, readonly ProblemDisruptionEntry[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, readonly ProblemDisruptionEntry[]>;
  } catch {
    return {};
  }
}

/**
 * Extract `disruptions[].recurrence` fail-safe: both fields positive finite
 * integers within bounds (intervalMinutes ≤ 1440 / maxFires ≤ 60); otherwise
 * undefined (fire once).
 */
export function parseDisruptionRecurrence(
  value: unknown,
): { intervalMinutes: number; maxFires: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { intervalMinutes?: unknown; maxFires?: unknown };
  const { intervalMinutes, maxFires } = v;
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 1440
  ) {
    return undefined;
  }
  if (
    typeof maxFires !== "number" ||
    !Number.isInteger(maxFires) ||
    maxFires < 1 ||
    maxFires > 60
  ) {
    return undefined;
  }
  return { intervalMinutes, maxFires };
}

/**
 * Narrow one `disruptions[]` entry to {@link ProblemDisruptionEntry}, or
 * `undefined` when `id` / `name` / `eventDetailType` are missing. triggers /
 * action / effect / recurrence delegate to their sub-parsers.
 */
export function parseDisruptionEntry(value: unknown): ProblemDisruptionEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    id?: unknown;
    name?: unknown;
    eventDetailType?: unknown;
    description?: unknown;
    defaultAfterMinutes?: unknown;
    operatorEditable?: unknown;
    parameters?: unknown;
    publicHint?: unknown;
    triggers?: unknown;
    action?: unknown;
    effect?: unknown;
    recurrence?: unknown;
  };
  if (
    typeof v.id !== "string" ||
    typeof v.name !== "string" ||
    typeof v.eventDetailType !== "string"
  ) {
    return undefined;
  }
  const triggers = parseDisruptionTriggers(v.triggers);
  const action = parseDisruptionAction(v.action);
  const effect = parseDisruptionEffect(v.effect);
  const recurrence = parseDisruptionRecurrence(v.recurrence);
  return {
    id: v.id,
    name: v.name,
    eventDetailType: v.eventDetailType,
    ...(typeof v.description === "string" ? { description: v.description } : {}),
    ...(typeof v.defaultAfterMinutes === "number"
      ? { defaultAfterMinutes: v.defaultAfterMinutes }
      : {}),
    ...(Array.isArray(v.operatorEditable)
      ? {
          operatorEditable: v.operatorEditable.filter((s): s is string => typeof s === "string"),
        }
      : {}),
    ...(v.parameters && typeof v.parameters === "object" && !Array.isArray(v.parameters)
      ? { parameters: v.parameters as Record<string, unknown> }
      : {}),
    ...(typeof v.publicHint === "boolean" ? { publicHint: v.publicHint } : {}),
    ...(triggers ? { triggers } : {}),
    ...(action ? { action } : {}),
    ...(effect ? { effect } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
}
