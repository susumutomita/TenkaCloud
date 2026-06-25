import { readdirSync } from "node:fs";
import { KIND_TO_DEFAULT_CATEGORY, KINDS, type Kind } from "./constants";
import { type CreateResult, runCreate } from "./create";
import { findProblemDir } from "./problem-loader";

/**
 * Issue #954: 6 kind の対話用ラベル + 1 行の使い分け説明。 issue 本文の onboarding flow と
 * 揃える (= 「Flag Challenge / Uptime Battle / Multi-service Battle / Attack Detection /
 * Migration Battle」)。 「Migration Battle」 は phased-polling kind に対応する (= 段階的に
 * 移行する system を polling して各 phase の状態を採点する典型 use case)。
 */
const KIND_INTERACTIVE_LABELS: Record<Kind, string> = {
  flag: "Flag Challenge       — SSM Parameter / CFn output を flag として提出",
  "multi-flag": "Multi-flag Challenge — 1 問に N 個の独立 flag、 個別提出で部分点採点",
  "uptime-flat": "Uptime Flat Battle   — 1 endpoint × N cycles の SLA 測定",
  "uptime-multi": "Multi-service Battle — N endpoints × N cycles、 全 OK で加点",
  "phased-polling":
    "Migration Battle     — 時系列 phase で system 状態が遷移、 各 phase を polling",
  "attack-detection": "Attack Detection     — 攻撃を fire して participant が検出するかを採点",
};

/**
 * Issue #954: テスト容易性のため input / output を依存注入できる prompt インターフェース。
 * 本体は `runInteractive` が `node:readline/promises` で実装した default を渡す。
 * unit test は scripted answer 配列を返す stub を渡して flow をなぞる。
 */
export interface InteractivePrompts {
  readonly ask: (question: string) => Promise<string>;
  readonly print: (line: string) => void;
}

export interface RunInteractiveResult {
  readonly created: CreateResult;
}

/**
 * Issue #954: `tenkacloud create problem` の対話モード。 初見の onboarding 体験を改善する
 * ため、 kind / problemId / display name / category 上書きを順に訊いて scaffold する。
 * 既存 `runCreate` を呼び出すだけで、 新規の生成ロジックは持たない (= Phase 1 は scaffold
 * のみ、 metadata 編集 / AI prompt 生成は Phase 2 へ持ち越し)。
 */
export async function runInteractive(prompts: InteractivePrompts): Promise<RunInteractiveResult> {
  const { print } = prompts;
  print("=== TenkaCloud problem authoring (interactive) ===");
  print("");
  const kind = await promptKind(prompts);
  const problemId = await promptProblemId(prompts);
  const category = await promptCategoryOverride(prompts, kind);
  printScaffoldPlan(print, kind, problemId, category ?? KIND_TO_DEFAULT_CATEGORY[kind]);
  await confirmCreate(prompts);
  const created = runCreate({
    problemId,
    kind,
    ...(category ? { category } : {}),
  });
  printCreatedFiles(print, created, problemId);
  return { created };
}

async function promptKind({ ask, print }: InteractivePrompts): Promise<Kind> {
  print("どの 種別 (= scoring kind) で問題を作成しますか?");
  print("");
  print("決定木 (= 迷ったら):");
  print("  競技者が 1 つの値 (flag) を提出して終わる        → 1 (flag)");
  print("  1 問に独立した複数 flag、 個別提出で部分点         → 2 (multi-flag)");
  print("  endpoint が 1 つ、 常時 200 で加点               → 3 (uptime-flat)");
  print("  endpoint が複数、 全部同時 200 で加点             → 4 (uptime-multi)");
  print("  時間経過で rule が変わる (= 移行 deadline 等)     → 5 (phased-polling)");
  print("  攻撃検知数で勝敗が決まる                          → 6 (attack-detection)");
  print("");
  const orderedKinds: readonly Kind[] = getOrderedKinds();
  for (const [i, k] of orderedKinds.entries()) {
    print(`  ${i + 1}) ${KIND_INTERACTIVE_LABELS[k]}`);
  }
  let kind: Kind | undefined;
  while (!kind) {
    const raw = (await ask("> 番号 (1-6) または kind 名: ")).trim();
    if (raw.length === 0) continue;
    const idx = Number.parseInt(raw, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= orderedKinds.length) {
      kind = orderedKinds[idx - 1];
      break;
    }
    if ((KINDS as readonly string[]).includes(raw)) {
      kind = raw as Kind;
      break;
    }
    print(
      `  ✗ "${raw}" は無効です。 1-6 の番号か kind 名 (${KINDS.join(" / ")}) を入力してください。`,
    );
  }
  print(`  → kind: ${kind}`);
  print("");
  return kind;
}

async function promptProblemId({ ask, print }: InteractivePrompts): Promise<string> {
  let problemId: string | undefined;
  while (!problemId) {
    const raw = (await ask("問題 ID (kebab-case, 3-32 chars, 例: my-first-problem): ")).trim();
    if (raw.length === 0) {
      print("  ✗ 問題 ID は省略できません。");
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(raw)) {
      print(
        `  ✗ "${raw}" は無効です。 kebab-case (小文字 a-z 0-9 -)、 3-32 chars にしてください。`,
      );
      continue;
    }
    if (findProblemDir(raw)) {
      print(`  ✗ "${raw}" は既に存在します。 別の ID にしてください。`);
      continue;
    }
    problemId = raw;
  }
  print(`  → problemId: ${problemId}`);
  print("");
  return problemId;
}

async function promptCategoryOverride(
  { ask, print }: InteractivePrompts,
  kind: Kind,
): Promise<"Battle" | "Challenge" | undefined> {
  // category は kind から自動決定。 上書きしたい場合だけ確認する。
  const defaultCategory = KIND_TO_DEFAULT_CATEGORY[kind];
  print(`category は kind から自動決定: ${defaultCategory} (default)`);
  const overrideRaw = (
    await ask(`  category を上書きしますか? [Enter で skip / Battle / Challenge]: `)
  ).trim();
  let category: "Battle" | "Challenge" | undefined;
  if (overrideRaw.length === 0) {
    category = undefined;
  } else if (overrideRaw === "Battle" || overrideRaw === "Challenge") {
    category = overrideRaw;
  } else {
    print(
      `  ✗ "${overrideRaw}" は無効。 Battle / Challenge / Enter のいずれかを入力してください。`,
    );
    print(`  → default の ${defaultCategory} で進めます`);
  }
  const effectiveCategory = category ?? defaultCategory;
  print(`  → category: ${effectiveCategory}`);
  print("");
  return category;
}

function printScaffoldPlan(
  print: (line: string) => void,
  kind: Kind,
  problemId: string,
  effectiveCategory: "Battle" | "Challenge",
): void {
  const categoryDir = effectiveCategory === "Battle" ? "battles" : "challenges";
  const outputRel = `problems/${categoryDir}/${problemId}/`;
  print("以下で scaffold を生成します:");
  print(`  - id:       ${problemId}`);
  print(`  - kind:     ${kind}`);
  print(`  - category: ${effectiveCategory}`);
  print(`  - 出力先:   ${outputRel}`);
  print("");
}

async function confirmCreate({ ask, print }: InteractivePrompts): Promise<void> {
  const confirm = (await ask("作成しますか? [Y/n]: ")).trim().toLowerCase();
  if (confirm === "n" || confirm === "no") {
    print("中止しました (= ファイルは作成されていません)。");
    throw new Error("aborted by user");
  }
}

function printCreatedFiles(
  print: (line: string) => void,
  created: CreateResult,
  problemId: string,
): void {
  print("");
  print(`✓ Created ${created.outputDir}`);
  print("  生成されたファイル:");
  for (const fileName of readdirSync(created.outputDir)) {
    print(`    └ ${fileName}`);
  }
  print("");
  print("Next steps:");
  print(
    `  1. ${created.outputDir}/metadata.json を編集 (name / description / tags / learningGoals)`,
  );
  print(`  2. ${created.outputDir}/template.yaml を編集 (実 AWS リソース)`);
  print(`  3. bun run scripts/tenkacloud-problem.ts cost ${problemId}`);
  print(`  4. bun run scripts/tenkacloud-problem.ts validate ${problemId}`);
  print("  5. make validate-problems");
  print("");
  print("参照:");
  print("  - problems/SCHEMA.json          (= metadata.json schema 正本)");
  print("  - /create-problem               (= Claude Code skill、 同等の対話を AI で進める)");
}

function getOrderedKinds(): readonly Kind[] {
  return [
    "flag",
    "multi-flag",
    "uptime-flat",
    "uptime-multi",
    "phased-polling",
    "attack-detection",
  ];
}
