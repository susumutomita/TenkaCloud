import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KIND_TO_DEFAULT_CATEGORY, type Kind, PROBLEMS_ROOT, TEMPLATES_ROOT } from "./constants";
import { findProblemDir } from "./problem-loader";

/**
 * Template 文字列の placeholder を replace。`__PROBLEM_ID__` -> 実 id、
 * `__PROBLEM_NAME__` -> id を Title Case 化したもの (= operator が後で書き換える前提)。
 * 他の `__TAG__` / `__HINT_1__` 等は author が手で埋める前提で残しておく。
 */
export function applyPlaceholders(content: string, problemId: string): string {
  const titleCase = problemId
    .split("-")
    .map((s) => (s.length > 0 ? s[0]?.toUpperCase() + s.slice(1) : ""))
    .join(" ");
  return content.replaceAll("__PROBLEM_ID__", problemId).replaceAll("__PROBLEM_NAME__", titleCase);
}

export interface CreateResult {
  readonly outputDir: string;
  readonly category: "Battle" | "Challenge";
  readonly kind: Kind;
}

export function runCreate(args: {
  problemId: string;
  kind: Kind;
  category?: "Battle" | "Challenge";
}): CreateResult {
  const { problemId, kind } = args;
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(problemId)) {
    throw new Error(
      `<id> must be kebab-case, 3-32 chars, lowercase a-z 0-9 -. Got: "${problemId}"`,
    );
  }
  if (findProblemDir(problemId)) {
    throw new Error(`Problem dir already exists for id="${problemId}". Choose a different id.`);
  }
  const category = args.category ?? KIND_TO_DEFAULT_CATEGORY[kind];
  const categoryDir = category === "Battle" ? "battles" : "challenges";
  const outputDir = join(PROBLEMS_ROOT, categoryDir, problemId);
  const templateDir = join(TEMPLATES_ROOT, kind);
  if (!existsSync(templateDir)) {
    throw new Error(`Template not found for kind="${kind}" at ${templateDir}`);
  }
  mkdirSync(outputDir, { recursive: true });
  for (const fileName of readdirSync(templateDir)) {
    const src = join(templateDir, fileName);
    const dst = join(outputDir, fileName);
    const content = readFileSync(src, "utf8");
    const processed = applyPlaceholders(content, problemId);
    writeFileSync(dst, processed, "utf8");
  }
  // category override が default と異なる場合 metadata.json の category field を書き換える。
  if (args.category && args.category !== KIND_TO_DEFAULT_CATEGORY[kind]) {
    const metadataPath = join(outputDir, "metadata.json");
    const m = JSON.parse(readFileSync(metadataPath, "utf8"));
    m.category = args.category;
    writeFileSync(metadataPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
  }
  return { outputDir, category, kind };
}
