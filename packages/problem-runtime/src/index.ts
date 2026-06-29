/**
 * @tenkacloud/problem-runtime — single source of truth for problem runtime
 * classification (ADR-023 / ADR-026 / ADR-027).
 *
 * The functions are pure and dependency-free so the Lambda esbuild bundle and
 * the bun-run CLI can both consume the TypeScript source directly.
 */

export interface SingleRuntimeDescriptor {
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
}

export interface CompositeRuntimeTarget {
  readonly id: string;
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
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

/**
 * Loose metadata shape accepted by {@link normalizeRuntime}. Both callers feed
 * already-`JSON.parse`d metadata (from EventBridge / catalog payloads or
 * `metadata.json`) without a Zod schema upfront, so every field is `unknown`.
 */
export type RuntimeMetadataInput = {
  readonly id?: unknown;
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
};

/** The only provider/engine the platform can execute today (ADR-023 D4). */
export const EXECUTABLE_PROVIDER = "aws" as const;
export const EXECUTABLE_ENGINE = "cloudformation" as const;

/** Default deploy body filename when neither `runtime.entry` nor `cfnTemplate` is declared. */
export const DEFAULT_ENTRY = "template.yaml" as const;

const COMPOSITE_TARGET_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_COMPOSITE_TARGETS = 2;
const MAX_COMPOSITE_TARGETS = 8;

/**
 * [ADR-026 / ADR-027] Provider/engine pairs the metadata layer recognizes as
 * **planned** (a real roadmap provider) but that are **not yet executable** (no
 * adapter registered). Distinguishing these from a typo lets the deploy worker
 * and the validator point authors at the tracker (#1408) instead of failing
 * generically. Each engine PR moves its pair out of this set as it ships.
 */
export const RESERVED_RUNTIMES: readonly { readonly provider: string; readonly engine: string }[] =
  [
    { provider: "sakura", engine: "apprun" }, // ADR-026
    { provider: "azure", engine: "bicep" }, // ADR-027
    { provider: "gcp", engine: "infra-manager" }, // ADR-027
  ];

/**
 * [ADR-023 / #2054] Provider/engine pairs delivered as a **local container**
 * (`make local`, the AWS-free local-play path), not deployed to a cloud account.
 * They are a deliberate, recognized runtime — distinct from an "unknown" typo —
 * but intentionally **not cloud-executable**, so the deploy worker still rejects
 * a cloud deploy of them (loudly, before any mutation).
 */
export const CONTAINER_RUNTIMES: readonly { readonly provider: string; readonly engine: string }[] =
  [
    { provider: "docker", engine: "compose" }, // ADR-023 local-play
  ];

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

function pushTargetStringIssue(
  issues: RuntimeValidationIssue[],
  problemId: string,
  path: string,
  target: Record<string, unknown>,
  key: "provider" | "engine" | "entry",
): void {
  if (typeof target[key] !== "string" || target[key].length === 0) {
    issues.push({
      problemId,
      path: `${path}.${key}`,
      message: `${key} must be a non-empty string`,
    });
  }
}

function validateCompositeTarget(
  target: unknown,
  index: number,
  problemId: string,
  seen: Set<string>,
): readonly RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  const path = `runtime.targets[${index}]`;
  if (!isRecord(target)) {
    return [{ problemId, path, message: "target must be an object" }];
  }
  if ("kind" in target) {
    issues.push({
      problemId,
      path: `${path}.kind`,
      message: "nested composite targets are not allowed",
    });
  }
  if ("targets" in target) {
    issues.push({
      problemId,
      path: `${path}.targets`,
      message: "nested composite targets are not allowed",
    });
  }
  for (const key of ["provider", "engine", "entry"] as const) {
    pushTargetStringIssue(issues, problemId, path, target, key);
  }
  if (typeof target.id !== "string" || !COMPOSITE_TARGET_ID_PATTERN.test(target.id)) {
    issues.push({ problemId, path: `${path}.id`, message: "id must match ^[a-z][a-z0-9-]{0,31}$" });
  } else if (seen.has(target.id)) {
    issues.push({ problemId, path: `${path}.id`, message: `duplicate target id ${target.id}` });
  } else {
    seen.add(target.id);
  }
  return issues;
}

function validateCompositeRuntime(
  runtime: Record<string, unknown>,
  problemId: string,
): readonly RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  if (!Array.isArray(runtime.targets)) {
    return [{ problemId, path: "runtime.targets", message: "composite runtime requires targets" }];
  }
  if (runtime.targets.length < MIN_COMPOSITE_TARGETS) {
    issues.push({
      problemId,
      path: "runtime.targets",
      message: "composite runtime requires at least 2 targets",
    });
  }
  if (runtime.targets.length > MAX_COMPOSITE_TARGETS) {
    issues.push({
      problemId,
      path: "runtime.targets",
      message: "composite runtime allows at most 8 targets",
    });
  }
  const seen = new Set<string>();
  runtime.targets.forEach((target, index) => {
    issues.push(...validateCompositeTarget(target, index, problemId, seen));
  });
  return issues;
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
    })),
  };
}

/**
 * Normalize a problem's runtime descriptor. Precedence:
 *   1. An explicit single `runtime` object → used as-is, but only if `provider` /
 *      `engine` / `entry` are all strings; otherwise the input is malformed and
 *      we return `undefined` (callers treat that as a loud failure).
 *   2. An explicit composite runtime → validated and returned with target order preserved.
 *   3. Legacy `cfnTemplate` (string) → `aws` / `cloudformation` / `<cfnTemplate>`.
 *   4. Neither declared → `aws` / `cloudformation` / `template.yaml`.
 */
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

/** True when the runtime is the one executable combination (`aws/cloudformation`). */
export function isExecutableRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    runtime.provider === EXECUTABLE_PROVIDER &&
    runtime.engine === EXECUTABLE_ENGINE
  );
}

/** True when the runtime is a planned-but-not-yet-executable roadmap pair. */
export function isReservedRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    RESERVED_RUNTIMES.some((r) => r.provider === runtime.provider && r.engine === runtime.engine)
  );
}

/** True when the runtime is a recognized local container runtime (ADR-023 local-play). */
export function isContainerRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  return (
    isSingleRuntime(runtime) &&
    CONTAINER_RUNTIMES.some((r) => r.provider === runtime.provider && r.engine === runtime.engine)
  );
}

export type RuntimeSupport = "executable" | "reserved" | "container" | "unknown" | "composite";

/**
 * Classify a runtime: executable (aws/cloudformation) / reserved (planned
 * roadmap provider) / container (local-play docker/compose) / composite /
 * unknown (likely a typo). Only "executable" and "composite" are cloud-deployed;
 * "reserved" and "container" are recognized-but-rejected, "unknown" is a typo.
 */
export function classifyRuntimeSupport(runtime: ProblemRuntimeDescriptor): RuntimeSupport {
  if (isCompositeRuntime(runtime)) return "composite";
  if (isExecutableRuntime(runtime)) return "executable";
  if (isReservedRuntime(runtime)) return "reserved";
  if (isContainerRuntime(runtime)) return "container";
  return "unknown";
}
