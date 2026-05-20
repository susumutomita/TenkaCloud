import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROBLEMS_ROOT } from "./constants";

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
  return typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
}
