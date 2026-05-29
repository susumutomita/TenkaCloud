import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROBLEMS_ROOT } from "./constants";

export type ProblemMetadata = Record<string, unknown>;

/**
 * [ADR-023] Normalized runtime descriptor. legacy `cfnTemplate` だけ宣言された問題は
 * `{provider:'aws', engine:'cloudformation', entry:cfnTemplate}` に正規化される (= 後方互換)。
 * 現在 executable な組み合わせは `aws` + `cloudformation` のみで、 それ以外は CLI validator が reject する。
 */
export interface NormalizedRuntime {
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
}

export const EXECUTABLE_PROVIDER = "aws";
export const EXECUTABLE_ENGINE = "cloudformation";

export function findProblemDir(problemId: string): string | undefined {
  for (const category of ["battles", "challenges"]) {
    const candidate = join(PROBLEMS_ROOT, category, problemId);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readProblemMetadata(dir: string): ProblemMetadata {
  return JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as ProblemMetadata;
}

export function getTemplateName(meta: ProblemMetadata): string {
  const runtime = meta.runtime as Record<string, unknown> | undefined;
  if (runtime && typeof runtime.entry === "string") {
    return runtime.entry;
  }
  return typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
}

/**
 * [ADR-023] Normalize a problem's runtime descriptor. Order of precedence:
 *   1. Explicit `runtime` block (must declare provider/engine/entry per SCHEMA).
 *   2. Legacy `cfnTemplate` → inferred as `aws` / `cloudformation` / <cfnTemplate>.
 *   3. Last-resort default `aws` / `cloudformation` / `template.yaml` (= scaffold baseline).
 *
 * Returns undefined only when `runtime` is malformed (= missing required keys).
 * Consistency between `runtime.entry` and `cfnTemplate` is not enforced here; that lives in the validator.
 */
export function normalizeRuntime(meta: ProblemMetadata): NormalizedRuntime | undefined {
  const runtime = meta.runtime as Record<string, unknown> | undefined;
  if (runtime !== undefined) {
    if (
      typeof runtime.provider !== "string" ||
      typeof runtime.engine !== "string" ||
      typeof runtime.entry !== "string"
    ) {
      return undefined;
    }
    return { provider: runtime.provider, engine: runtime.engine, entry: runtime.entry };
  }
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
  return { provider: EXECUTABLE_PROVIDER, engine: EXECUTABLE_ENGINE, entry: cfnTemplate };
}

export function isExecutableRuntime(runtime: NormalizedRuntime): boolean {
  return runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE;
}

/**
 * [ADR-026 / ADR-027] Runtimes recognized as **planned** roadmap providers but
 * not yet executable (no engine adapter). Distinguishing them from a typo lets
 * the validator tell an author "author it once the adapter lands (#1408)" vs
 * "you misspelled the provider". Kept in lock-step with the Lambda-side
 * `infrastructure/lib/problem-deploy/handlers/shared/runtime/normalize.ts`
 * (the two run in separate bundles and cannot share a module).
 */
export const RESERVED_RUNTIMES: readonly { readonly provider: string; readonly engine: string }[] =
  [
    { provider: "sakura", engine: "apprun" }, // ADR-026
    { provider: "azure", engine: "bicep" }, // ADR-027
    { provider: "gcp", engine: "infra-manager" }, // ADR-027
  ];

export type RuntimeSupport = "executable" | "reserved" | "unknown";

/** Classify a normalized runtime as executable / reserved (planned) / unknown (likely a typo). */
export function classifyRuntimeSupport(runtime: NormalizedRuntime): RuntimeSupport {
  if (isExecutableRuntime(runtime)) return "executable";
  if (RESERVED_RUNTIMES.some((r) => r.provider === runtime.provider && r.engine === runtime.engine))
    return "reserved";
  return "unknown";
}
