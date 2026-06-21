#!/usr/bin/env bun
/**
 * Issue #1910 Slice 5: `docs/problems/COST-CATALOG.md` を生成する。
 *
 * 各問題の `template.yaml` を offline cost model (`scripts/lib/problem-cost.ts`) に通し、
 * 「使用 AWS リソース + 概算コスト (時間 / セッション / 放置 1 日) + always-on フラグ」を
 * 1 つの markdown テーブルに集約する。 GitHub 上で問題のコスト感を一覧できる surface。
 *
 * Usage:
 *   bun run scripts/build-cost-catalog.ts          # 生成 (= overwrite)
 *   bun run scripts/build-cost-catalog.ts --check   # 既存ファイルとの drift 検出
 *
 * 設計メモ:
 *   - markdown 組み立ては `scripts/lib/cost-catalog.ts` の純関数 (= unit test 済み)。
 *   - `index.json` (= submodule catalog CI 所有) と異なり、 これはコスト model が本体 repo
 *     側にあるため本体 repo の生成物。 ただし submodule bump 由来の drift で CI を落とさない
 *     よう `make check-cost-catalog` は default の CI / before-commit には載せず、 オンデマンド
 *     再生成とする (index.json と同じ哲学)。
 *   - HTML は `make build-docs` が markdown から生成する。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type CostCatalogEntry, renderCostCatalog } from "./lib/cost-catalog";
import { analyzeProblemCost } from "./lib/problem-cost";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROBLEMS_DIR = join(REPO_ROOT, "problems");
const OUTPUT_PATH = join(REPO_ROOT, "docs", "problems", "COST-CATALOG.md");

interface ProblemMetadata {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly estimatedDuration: string;
}

function findMetadataFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (entry === "node_modules") continue;
    if (isDir) {
      found.push(...findMetadataFiles(full));
    } else if (entry === "metadata.json") {
      found.push(full);
    }
  }
  return found;
}

function readTemplate(metadataFile: string): string {
  try {
    return readFileSync(join(dirname(metadataFile), "template.yaml"), "utf8");
  } catch {
    return "";
  }
}

function buildEntries(): CostCatalogEntry[] {
  const entries: CostCatalogEntry[] = [];
  for (const file of findMetadataFiles(PROBLEMS_DIR)) {
    const meta = JSON.parse(readFileSync(file, "utf8")) as ProblemMetadata;
    const estimate = analyzeProblemCost(readTemplate(file), meta.estimatedDuration);
    entries.push({
      id: meta.id,
      name: meta.name,
      category: meta.category,
      estimatedDuration: meta.estimatedDuration,
      estimate,
    });
  }
  return entries;
}

function main(): void {
  const isCheck = process.argv.includes("--check");
  const markdown = renderCostCatalog(buildEntries());
  const rel = relative(REPO_ROOT, OUTPUT_PATH);

  if (isCheck) {
    let existing = "";
    try {
      existing = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      console.error(`NG  ${rel} が存在しません。 \`make cost-catalog\` で生成してください。`);
      process.exit(1);
    }
    if (existing !== markdown) {
      console.error(
        `NG  ${rel} が problem template と乖離しています。 \`make cost-catalog\` で再生成してください。`,
      );
      process.exit(1);
    }
    console.log(`OK  ${rel}`);
    return;
  }

  writeFileSync(OUTPUT_PATH, markdown);
  console.log(`Wrote ${rel}`);
}

main();
