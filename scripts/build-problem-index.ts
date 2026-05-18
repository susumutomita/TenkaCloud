#!/usr/bin/env bun
/**
 * ADR-008 Phase 1 / Issue #574: `problems/index.json` を生成する。
 *
 * Usage:
 *   bun run scripts/build-problem-index.ts            # 生成 (= overwrite)
 *   bun run scripts/build-problem-index.ts --check    # 既存ファイルとの差分を検出 (CI 用)
 *
 * 目的:
 *   ADR-008 で、 admin / portal が **catalog だけ** をロードして問題を列挙できるよう、
 *   全 metadata.json のサマリだけを集約した `problems/index.json` を生成する。
 *   Phase 4 で private repo (`TenkaCloudChallenges`) の publish CI が、 metadata の
 *   diff を本体 repo に PR で同期する経路の **書き込み先** が本ファイル。
 *
 * 含めるフィールド (= portal / admin が一覧表示に使う最小集合):
 *   id / name / category / status / visibility / difficulty / estimatedDuration /
 *   shortDescription / tags / scoringKind
 *
 * 含めないフィールド (= 全文は metadata.json or S3 payload 側で持つ):
 *   description / learningGoals / endpoints / cfnParameters / phases / disruptions /
 *   dashboard / i18n
 *
 * 安定化:
 *   - id 順で sort (= 並び順が決定的)
 *   - `generatedAt` 等の timestamp は埋め込まない (= drift 検出が壊れる)
 *   - JSON は 2 spaces indent + trailing newline (= biome / git diff と整合)
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROBLEMS_DIR = join(REPO_ROOT, "problems");
const INDEX_PATH = join(PROBLEMS_DIR, "index.json");

interface ProblemMetadata {
  id: string;
  name: string;
  category: "Battle" | "Challenge";
  status: "ready" | "draft" | "deprecated";
  visibility?: "public" | "private";
  difficulty: 1 | 2 | 3 | 4 | 5;
  estimatedDuration: string;
  shortDescription: string;
  tags?: readonly string[];
  scoring?: { kind?: string };
}

interface ProblemIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly category: "Battle" | "Challenge";
  readonly status: "ready" | "draft" | "deprecated";
  readonly visibility: "public" | "private";
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly estimatedDuration: string;
  readonly shortDescription: string;
  readonly tags: readonly string[];
  readonly scoringKind: string | null;
}

interface ProblemIndex {
  readonly version: "1";
  readonly problems: readonly ProblemIndexEntry[];
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

function toEntry(m: ProblemMetadata): ProblemIndexEntry {
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    status: m.status,
    visibility: m.visibility ?? "public",
    difficulty: m.difficulty,
    estimatedDuration: m.estimatedDuration,
    shortDescription: m.shortDescription,
    tags: m.tags ?? [],
    scoringKind: m.scoring?.kind ?? null,
  };
}

function buildIndex(): ProblemIndex {
  const files = findMetadataFiles(PROBLEMS_DIR);
  const entries: ProblemIndexEntry[] = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8")) as ProblemMetadata;
    entries.push(toEntry(data));
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { version: "1", problems: entries };
}

/**
 * JSON.stringify の出力に biome JSON formatter を被せる (= short array を inline 化する
 * など、 既存 repo の JSON 整形ルールに揃える)。 そうしないと `--check` で drift と判定される。
 * biome は stdin/stdout 経由で format できる (`biome format --stdin-file-path=...`)。
 */
function serialize(index: ProblemIndex): string {
  const raw = `${JSON.stringify(index, null, 2)}\n`;
  const result = spawnSync("bun", ["biome", "format", "--stdin-file-path=problems/index.json"], {
    input: raw,
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    throw new Error(`biome format failed: ${result.stderr}`);
  }
  return result.stdout;
}

function main(): void {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const index = buildIndex();
  const serialized = serialize(index);
  const rel = relative(REPO_ROOT, INDEX_PATH);

  if (isCheck) {
    let existing = "";
    try {
      existing = readFileSync(INDEX_PATH, "utf8");
    } catch {
      console.error(
        `NG  ${rel} が存在しません。 \`bun run build:problems-index\` で生成してください。`,
      );
      process.exit(1);
    }
    if (existing !== serialized) {
      console.error(
        `NG  ${rel} が metadata.json と乖離しています。 \`bun run build:problems-index\` で再生成してください。`,
      );
      process.exit(1);
    }
    console.log(`OK  ${rel} は ${index.problems.length} 件の metadata と一致しています`);
    return;
  }

  writeFileSync(INDEX_PATH, serialized);
  console.log(`Wrote ${rel} (${index.problems.length} entries)`);
}

main();
