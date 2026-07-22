/**
 * @tenkacloud/problem-runtime — single source of truth for problem runtime
 * classification and Composite Runtime dataflow (ADR-023 / ADR-026 / ADR-027).
 *
 * The functions are pure and dependency-free so Lambda bundles, the SDK, authoring
 * tools, and local play consume the same contract.
 */

export interface SingleRuntimeDescriptor {
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
}

export type CompositeOutputSensitivity = "public" | "sensitive";

/** One output a target may expose to another target. */
export interface CompositeOutputDeclaration {
  readonly sensitivity: CompositeOutputSensitivity;
}

/** Explicit provider-neutral input binding from one upstream target output. */
export interface CompositeInputBinding {
  readonly fromTarget: string;
  readonly output: string;
  /** Required when the upstream output is classified as sensitive. */
  readonly allowSensitive?: boolean;
}

export interface CompositeRuntimeTarget {
  readonly id: string;
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
  /** Explicit prerequisites. Declaration order never implies dependency. */
  readonly dependsOn?: readonly string[];
  /** Downstream provider parameter name -> upstream output binding. */
  readonly inputs?: Readonly<Record<string, CompositeInputBinding>>;
  /** Outputs this target permits downstream targets to reference. */
  readonly outputs?: Readonly<Record<string, CompositeOutputDeclaration>>;
}

export interface CompositeRuntimeDescriptor {
  readonly kind: "composite";
  readonly targets: readonly CompositeRuntimeTarget[];
}

/** Normalized single-provider runtime descriptor — the legacy shape every reader agrees on. */
export type RuntimeDescriptor = SingleRuntimeDescriptor;

/** Normalized runtime descriptor including the Composite metadata shape. */
export type ProblemRuntimeDescriptor = RuntimeDescriptor | CompositeRuntimeDescriptor;

export interface RuntimeValidationIssue {
  readonly problemId: string;
  readonly path: string;
  readonly message: string;
}

export class RuntimeValidationError extends Error {
  public readonly issues: readonly RuntimeValidationIssue[];

  public constructor(issues: readonly RuntimeValidationIssue[]) {
    super(issues.map((issue) => `${issue.problemId}:${issue.path}: ${issue.message}`).join("; "));
    this.name = "RuntimeValidationError";
    this.issues = issues;
  }
}

export type RuntimeMetadataInput = {
  readonly id?: unknown;
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
};

export const EXECUTABLE_PROVIDER = "aws" as const;
export const EXECUTABLE_ENGINE = "cloudformation" as const;
export const DEFAULT_ENTRY = "template.yaml" as const;

const COMPOSITE_TARGET_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const COMPOSITE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const AWS_PARAMETER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,254}$/;
const IDENTIFIER_PARAMETER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MIN_COMPOSITE_TARGETS = 2;
export const MAX_COMPOSITE_TARGETS = 8;

export const RESERVED_RUNTIMES = [
  { provider: "sakura", engine: "apprun" },
  { provider: "azure", engine: "bicep" },
  { provider: "gcp", engine: "infra-manager" },
] as const;

export type ReservedProvider = (typeof RESERVED_RUNTIMES)[number]["provider"];

export const CONTAINER_RUNTIMES: readonly { readonly provider: string; readonly engine: string }[] =
  [{ provider: "docker", engine: "compose" }];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemIdFrom(meta: RuntimeMetadataInput): string {
  return typeof meta.id === "string" && meta.id.length > 0 ? meta.id : "<unknown>";
}

function singleRuntimeFrom(runtime: Record<string, unknown>): SingleRuntimeDescriptor | undefined {
  if (
    typeof runtime.provider !== "string" ||
    typeof runtime.engine !== "string" ||
    typeof runtime.entry !== "string"
  ) {
    return undefined;
  }
  return { provider: runtime.provider, engine: runtime.engine, entry: runtime.entry };
}

function issue(
  problemId: string,
  path: string,
  message: string,
): RuntimeValidationIssue {
  return { problemId, path, message };
}

function pushTargetStringIssue(
  issues: RuntimeValidationIssue[],
  problemId: string,
  path: string,
  target: Record<string, unknown>,
  key: "provider" | "engine" | "entry",
): void {
  if (typeof target[key] !== "string" || target[key].length === 0) {
    issues.push(issue(problemId, `${path}.${key}`, `${key} must be a non-empty string`));
  }
}

function parameterPattern(provider: string): RegExp {
  return provider === "aws" ? AWS_PARAMETER_PATTERN : IDENTIFIER_PARAMETER_PATTERN;
}

function validateOutputDeclarations(
  raw: unknown,
  problemId: string,
  path: string,
): RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  if (raw === undefined) return issues;
  if (!isRecord(raw)) return [issue(problemId, path, "outputs must be an object")];
  for (const [name, declaration] of Object.entries(raw)) {
    if (!COMPOSITE_OUTPUT_NAME_PATTERN.test(name)) {
      issues.push(issue(problemId, `${path}.${name}`, "output name is invalid"));
      continue;
    }
    if (!isRecord(declaration)) {
      issues.push(issue(problemId, `${path}.${name}`, "output declaration must be an object"));
      continue;
    }
    if (declaration.sensitivity !== "public" && declaration.sensitivity !== "sensitive") {
      issues.push(
        issue(
          problemId,
          `${path}.${name}.sensitivity`,
          "sensitivity must be public or sensitive",
        ),
      );
    }
  }
  return issues;
}

function validateDependsOn(
  raw: unknown,
  problemId: string,
  path: string,
): RuntimeValidationIssue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [issue(problemId, path, "dependsOn must be an array")];
  const issues: RuntimeValidationIssue[] = [];
  const seen = new Set<string>();
  raw.forEach((dependency, index) => {
    if (typeof dependency !== "string" || !COMPOSITE_TARGET_ID_PATTERN.test(dependency)) {
      issues.push(issue(problemId, `${path}[${index}]`, "dependency must be a valid target id"));
    } else if (seen.has(dependency)) {
      issues.push(issue(problemId, `${path}[${index}]`, `duplicate dependency ${dependency}`));
    } else {
      seen.add(dependency);
    }
  });
  return issues;
}

function validateInputsShape(
  raw: unknown,
  provider: string,
  problemId: string,
  path: string,
): RuntimeValidationIssue[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return [issue(problemId, path, "inputs must be an object")];
  const issues: RuntimeValidationIssue[] = [];
  const expectedParameter = parameterPattern(provider);
  for (const [parameterName, binding] of Object.entries(raw)) {
    if (!expectedParameter.test(parameterName)) {
      issues.push(
        issue(
          problemId,
          `${path}.${parameterName}`,
          `parameter name is invalid for provider ${provider || "<unknown>"}`,
        ),
      );
    }
    if (!isRecord(binding)) {
      issues.push(issue(problemId, `${path}.${parameterName}`, "binding must be an object"));
      continue;
    }
    if (
      typeof binding.fromTarget !== "string" ||
      !COMPOSITE_TARGET_ID_PATTERN.test(binding.fromTarget)
    ) {
      issues.push(
        issue(problemId, `${path}.${parameterName}.fromTarget`, "fromTarget must be a valid target id"),
      );
    }
    if (
      typeof binding.output !== "string" ||
      !COMPOSITE_OUTPUT_NAME_PATTERN.test(binding.output)
    ) {
      issues.push(issue(problemId, `${path}.${parameterName}.output`, "output name is invalid"));
    }
    if (binding.allowSensitive !== undefined && typeof binding.allowSensitive !== "boolean") {
      issues.push(
        issue(problemId, `${path}.${parameterName}.allowSensitive`, "allowSensitive must be boolean"),
      );
    }
  }
  return issues;
}

function validateCompositeTargetShape(
  target: unknown,
  index: number,
  problemId: string,
  seen: Set<string>,
): RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  const path = `runtime.targets[${index}]`;
  if (!isRecord(target)) return [issue(problemId, path, "target must be an object")];
  if ("kind" in target) {
    issues.push(issue(problemId, `${path}.kind`, "nested composite targets are not allowed"));
  }
  if ("targets" in target) {
    issues.push(issue(problemId, `${path}.targets`, "nested composite targets are not allowed"));
  }
  for (const key of ["provider", "engine", "entry"] as const) {
    pushTargetStringIssue(issues, problemId, path, target, key);
  }
  if (typeof target.id !== "string" || !COMPOSITE_TARGET_ID_PATTERN.test(target.id)) {
    issues.push(issue(problemId, `${path}.id`, "id must match ^[a-z][a-z0-9-]{0,31}$"));
  } else if (seen.has(target.id)) {
    issues.push(issue(problemId, `${path}.id`, `duplicate target id ${target.id}`));
  } else {
    seen.add(target.id);
  }
  issues.push(...validateDependsOn(target.dependsOn, problemId, `${path}.dependsOn`));
  issues.push(
    ...validateInputsShape(
      target.inputs,
      typeof target.provider === "string" ? target.provider : "",
      problemId,
      `${path}.inputs`,
    ),
  );
  issues.push(...validateOutputDeclarations(target.outputs, problemId, `${path}.outputs`));
  return issues;
}

function validateCompositeGraph(
  targets: readonly Record<string, unknown>[],
  problemId: string,
): RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  targets.forEach((target) => {
    if (typeof target.id === "string" && COMPOSITE_TARGET_ID_PATTERN.test(target.id)) {
      if (!byId.has(target.id)) byId.set(target.id, target);
    }
  });

  targets.forEach((target, index) => {
    if (typeof target.id !== "string" || !byId.has(target.id)) return;
    const path = `runtime.targets[${index}]`;
    const dependencies = Array.isArray(target.dependsOn)
      ? target.dependsOn.filter((value): value is string => typeof value === "string")
      : [];
    for (const dependency of dependencies) {
      if (dependency === target.id) {
        issues.push(issue(problemId, `${path}.dependsOn`, "target cannot depend on itself"));
      } else if (!byId.has(dependency)) {
        issues.push(issue(problemId, `${path}.dependsOn`, `unknown dependency ${dependency}`));
      }
    }

    if (!isRecord(target.inputs)) return;
    for (const [parameterName, rawBinding] of Object.entries(target.inputs)) {
      if (!isRecord(rawBinding)) continue;
      const fromTarget = rawBinding.fromTarget;
      const output = rawBinding.output;
      if (typeof fromTarget !== "string" || typeof output !== "string") continue;
      if (!byId.has(fromTarget)) {
        issues.push(
          issue(
            problemId,
            `${path}.inputs.${parameterName}.fromTarget`,
            `unknown upstream target ${fromTarget}`,
          ),
        );
        continue;
      }
      if (!dependencies.includes(fromTarget)) {
        issues.push(
          issue(
            problemId,
            `${path}.inputs.${parameterName}.fromTarget`,
            `binding source ${fromTarget} must also appear in dependsOn`,
          ),
        );
      }
      const upstream = byId.get(fromTarget);
      const declarations = upstream?.outputs;
      if (!isRecord(declarations) || !isRecord(declarations[output])) {
        issues.push(
          issue(
            problemId,
            `${path}.inputs.${parameterName}.output`,
            `upstream target ${fromTarget} does not declare output ${output}`,
          ),
        );
        continue;
      }
      const sensitivity = (declarations[output] as Record<string, unknown>).sensitivity;
      if (sensitivity === "sensitive" && rawBinding.allowSensitive !== true) {
        issues.push(
          issue(
            problemId,
            `${path}.inputs.${parameterName}.allowSensitive`,
            `sensitive output ${fromTarget}.${output} requires allowSensitive: true`,
          ),
        );
      }
    }
  });

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (targetId: string): void => {
    if (state.get(targetId) === "visited") return;
    if (state.get(targetId) === "visiting") {
      const start = stack.indexOf(targetId);
      const cycle = [...stack.slice(start), targetId];
      issues.push(issue(problemId, "runtime.targets", `dependency cycle: ${cycle.join(" -> ")}`));
      return;
    }
    state.set(targetId, "visiting");
    stack.push(targetId);
    const target = byId.get(targetId);
    const dependencies = Array.isArray(target?.dependsOn) ? target.dependsOn : [];
    for (const dependency of dependencies) {
      if (typeof dependency === "string" && byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(targetId, "visited");
  };
  for (const targetId of byId.keys()) visit(targetId);
  return issues;
}

function validateCompositeRuntime(
  runtime: Record<string, unknown>,
  problemId: string,
): readonly RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  if (!Array.isArray(runtime.targets)) {
    return [issue(problemId, "runtime.targets", "composite runtime requires targets")];
  }
  if (runtime.targets.length < MIN_COMPOSITE_TARGETS) {
    issues.push(issue(problemId, "runtime.targets", "composite runtime requires at least 2 targets"));
  }
  if (runtime.targets.length > MAX_COMPOSITE_TARGETS) {
    issues.push(issue(problemId, "runtime.targets", "composite runtime allows at most 8 targets"));
  }
  const seen = new Set<string>();
  runtime.targets.forEach((target, index) => {
    issues.push(...validateCompositeTargetShape(target, index, problemId, seen));
  });
  if (runtime.targets.every(isRecord)) {
    issues.push(...validateCompositeGraph(runtime.targets, problemId));
  }
  return issues;
}

function normalizedOutputs(raw: unknown): Readonly<Record<string, CompositeOutputDeclaration>> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, CompositeOutputDeclaration> = {};
  for (const [name, declaration] of Object.entries(raw)) {
    result[name] = {
      sensitivity: (declaration as Record<string, unknown>).sensitivity as CompositeOutputSensitivity,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizedInputs(raw: unknown): Readonly<Record<string, CompositeInputBinding>> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, CompositeInputBinding> = {};
  for (const [parameter, binding] of Object.entries(raw)) {
    const record = binding as Record<string, unknown>;
    result[parameter] = {
      fromTarget: record.fromTarget as string,
      output: record.output as string,
      ...(record.allowSensitive === true ? { allowSensitive: true } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compositeRuntimeFrom(
  runtime: Record<string, unknown>,
  problemId: string,
): CompositeRuntimeDescriptor | undefined {
  const issues = validateCompositeRuntime(runtime, problemId);
  if (issues.length > 0) throw new RuntimeValidationError(issues);
  return {
    kind: "composite",
    targets: (runtime.targets as Record<string, unknown>[]).map((target) => ({
      id: target.id as string,
      provider: target.provider as string,
      engine: target.engine as string,
      entry: target.entry as string,
      ...(Array.isArray(target.dependsOn) && target.dependsOn.length > 0
        ? { dependsOn: [...(target.dependsOn as string[])] }
        : {}),
      ...(normalizedInputs(target.inputs) ? { inputs: normalizedInputs(target.inputs) } : {}),
      ...(normalizedOutputs(target.outputs) ? { outputs: normalizedOutputs(target.outputs) } : {}),
    })),
  };
}

/** Normalize a problem's runtime descriptor. */
export function normalizeRuntime(meta: RuntimeMetadataInput): ProblemRuntimeDescriptor | undefined {
  const runtime = meta.runtime;
  if (runtime !== undefined && runtime !== null) {
    if (!isRecord(runtime)) return undefined;
    if (runtime.kind === "composite") return compositeRuntimeFrom(runtime, problemIdFrom(meta));
    return singleRuntimeFrom(runtime);
  }
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : DEFAULT_ENTRY;
  return { provider: EXECUTABLE_PROVIDER, engine: EXECUTABLE_ENGINE, entry: cfnTemplate };
}

export function isCompositeRuntime(
  runtime: ProblemRuntimeDescriptor,
): runtime is CompositeRuntimeDescriptor {
  return "kind" in runtime && runtime.kind === "composite";
}

export function isSingleRuntime(
  runtime: ProblemRuntimeDescriptor,
): runtime is SingleRuntimeDescriptor {
  return !isCompositeRuntime(runtime);
}

export function isExecutableRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    runtime.provider === EXECUTABLE_PROVIDER &&
    runtime.engine === EXECUTABLE_ENGINE
  );
}

export function isReservedRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    RESERVED_RUNTIMES.some((r) => r.provider === runtime.provider && r.engine === runtime.engine)
  );
}

export function isContainerRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    CONTAINER_RUNTIMES.some((r) => r.provider === runtime.provider && r.engine === runtime.engine)
  );
}

export type RuntimeSupport = "executable" | "reserved" | "container" | "unknown" | "composite";

export function classifyRuntimeSupport(runtime: ProblemRuntimeDescriptor): RuntimeSupport {
  if (isCompositeRuntime(runtime)) return "composite";
  if (isExecutableRuntime(runtime)) return "executable";
  if (isReservedRuntime(runtime)) return "reserved";
  if (isContainerRuntime(runtime)) return "container";
  return "unknown";
}

export {
  buildCompositeDeploymentPlan,
  COMPOSITE_PROVIDERS,
  type CompositeDeploymentPlan,
  type CompositeDeploymentPlanTarget,
  type CompositeProvider,
} from "./composite-plan.js";
