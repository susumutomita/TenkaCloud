import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROBLEMS_ROOT } from "./constants";

export type { RuntimeDescriptor as NormalizedRuntime } from "@tenkacloud/problem-runtime";
/**
 * [#1423] Runtime classification (normalize / executable / reserved) is owned by
 * `@tenkacloud/problem-runtime` — the single source of truth shared with the
 * deploy worker Lambda. It is re-exported here under the CLI's historical names
 * so existing importers (validate / inspect / create / interactive) keep working
 * unchanged. Only the file-IO helpers below are CLI-specific.
 */
export {
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isExecutableRuntime,
  isReservedRuntime,
  normalizeRuntime,
  RESERVED_RUNTIMES,
  type RuntimeSupport,
} from "@tenkacloud/problem-runtime";

export type ProblemMetadata = Record<string, unknown>;

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
