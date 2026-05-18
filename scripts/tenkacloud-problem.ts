#!/usr/bin/env bun
/**
 * ADR-012 Phase 6: `tenkacloud problem` CLI subcommand 群。
 *
 * MVP は `create` と `validate` のみ実装。 `dev` / `package` / `publish` は次 phase。
 *
 * 使い方:
 *   bun run scripts/tenkacloud-problem.ts create <id> --kind <kind> [--category Battle|Challenge]
 *   bun run scripts/tenkacloud-problem.ts validate <id>
 *   bun run scripts/tenkacloud-problem.ts list-kinds
 *
 * 設計判断:
 *   - placeholder 文字列 (`__PROBLEM_ID__` / `__PROBLEM_NAME__` 等) を template から replace
 *     する素朴な方式。 templating engine (handlebars / ejs) は導入しない (= 依存最小化)。
 *   - category は kind から自動決定可: flag → Challenge、 それ以外 → Battle。 上書きしたい
 *     場合のみ --category で指定。
 *   - validate は `make validate-problems` を呼んだ後、 kind 別の追加 check (= endpoints[].
 *     default.key が template.yaml の Outputs に存在するか) を行う。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TEMPLATES_ROOT = join(REPO_ROOT, ".claude/templates/problems");
const PROBLEMS_ROOT = join(REPO_ROOT, "problems");

const KINDS = [
  "flag",
  "uptime-flat",
  "uptime-multi",
  "phased-polling",
  "attack-detection",
] as const;
type Kind = (typeof KINDS)[number];

/**
 * Kind → default category mapping。 flag は Challenge、 残りは Battle が想定の主用途。
 * operator は --category override で上書き可能。
 */
const KIND_TO_DEFAULT_CATEGORY: Record<Kind, "Battle" | "Challenge"> = {
  flag: "Challenge",
  "uptime-flat": "Battle",
  "uptime-multi": "Battle",
  "phased-polling": "Battle",
  "attack-detection": "Battle",
};

interface CliArgs {
  command: "create" | "validate" | "list-kinds" | "dry-run" | "inspect" | "help" | "interactive";
  problemId?: string;
  kind?: Kind;
  category?: "Battle" | "Challenge";
  /** dry-run --submitted <flag> (flag kind) */
  submitted?: string;
  /** dry-run --reveal-hints <count> (flag / uptime kinds) */
  revealHints?: number;
  /** dry-run --cycles <N> (uptime-flat kind) */
  cycles?: number;
  /** dry-run --pattern <s|f sequence> (uptime-flat kind, e.g. "ssfsf") */
  pattern?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help" };
  }
  const command = argv[0];
  if (command === "list-kinds") return { command };
  // Issue #954: interactive mode は引数なしで起動する `tenkacloud problem interactive` か、
  // `tenkacloud problem create` (= problemId / kind 省略時) のどちらでも入れる。
  if (command === "interactive") return { command };
  if (
    command !== "create" &&
    command !== "validate" &&
    command !== "dry-run" &&
    command !== "inspect"
  ) {
    throw new Error(
      `unknown command: ${command}. Try 'help', 'list-kinds', 'create', 'validate', 'dry-run', 'inspect', 'interactive'.`,
    );
  }
  const problemId = argv[1];
  if (!problemId) {
    // `create` without args → interactive で誘導する (= 初見の onboarding 体験を改善)
    if (command === "create") return { command: "interactive" };
    throw new Error(`${command} requires <problemId>`);
  }
  const result: CliArgs = { command, problemId };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--kind") {
      const v = argv[i + 1];
      if (!v || !(KINDS as readonly string[]).includes(v)) {
        throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
      }
      result.kind = v as Kind;
      i += 1;
    } else if (flag === "--category") {
      const v = argv[i + 1];
      if (v !== "Battle" && v !== "Challenge") {
        throw new Error(`--category must be Battle or Challenge`);
      }
      result.category = v;
      i += 1;
    } else if (flag === "--submitted") {
      result.submitted = argv[i + 1] ?? "";
      i += 1;
    } else if (flag === "--reveal-hints") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("--reveal-hints must be a non-negative integer");
      }
      result.revealHints = n;
      i += 1;
    } else if (flag === "--cycles") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("--cycles must be a positive integer");
      }
      result.cycles = n;
      i += 1;
    } else if (flag === "--pattern") {
      const v = argv[i + 1];
      // pattern は kind 別に意味が違うため caller で validation (= runDryRun 内)。
      // 文字種は s/f (uptime), e/l/c/a (phased-polling), 0-9 (attack-detection) を許容。
      if (typeof v !== "string" || !/^[a-z0-9]+$/.test(v)) {
        throw new Error(
          "--pattern must be a non-empty string of [a-z0-9] (e.g. 'ssfsf' for uptime, 'eeeellll' for phased-polling, '12321' for attack-detection)",
        );
      }
      result.pattern = v;
      i += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return result;
}

function printHelp(): void {
  console.log(`tenkacloud problem — TenkaCloud 問題 authoring CLI (ADR-012 Phase 6)

Usage:
  bun run scripts/tenkacloud-problem.ts create <id> --kind <kind> [--category Battle|Challenge]
  bun run scripts/tenkacloud-problem.ts create               # interactive (= 初心者向け、 引数なしで起動)
  bun run scripts/tenkacloud-problem.ts interactive          # 上と同じ (= 明示形)
  bun run scripts/tenkacloud-problem.ts validate <id>
  bun run scripts/tenkacloud-problem.ts dry-run <id> [--submitted <flag>] [--reveal-hints N]
                                                    [--cycles N] [--pattern <s|f sequence>]
  bun run scripts/tenkacloud-problem.ts inspect <id>  # metadata + template の全体 dump (= author debug)
  bun run scripts/tenkacloud-problem.ts list-kinds

Available kinds:  ${KINDS.join(", ")}

Examples:
  bun run scripts/tenkacloud-problem.ts create my-battle --kind uptime-multi
  bun run scripts/tenkacloud-problem.ts create hello-flag --kind flag
  bun run scripts/tenkacloud-problem.ts create        # 対話形式で kind / id / category を選ぶ
  bun run scripts/tenkacloud-problem.ts validate microservice-migration-battle
  bun run scripts/tenkacloud-problem.ts dry-run hello-world --submitted "actual-flag-value"
  bun run scripts/tenkacloud-problem.ts dry-run hello-world-battle --cycles 60 --pattern "ssssffssssss"
  bun run scripts/tenkacloud-problem.ts inspect hello-world

See also:
  docs/problems/AUTHORING.html  — 30 分 onboarding guide
  problems/SCHEMA.json          — metadata.json schema
  .claude/skills/create-problem — Claude Code skill (= /create-problem)
`);
}

function listKinds(): void {
  for (const k of KINDS) {
    console.log(`${k.padEnd(20)} → category=${KIND_TO_DEFAULT_CATEGORY[k]}`);
  }
}

/**
 * Template 文字列の placeholder を replace。`__PROBLEM_ID__` → 実 id、
 * `__PROBLEM_NAME__` → id を Title Case 化したもの (= operator が後で書き換える前提)。
 * 他の `__TAG__` / `__HINT_1__` 等は author が手で埋める前提で残しておく。
 */
function applyPlaceholders(content: string, problemId: string): string {
  const titleCase = problemId
    .split("-")
    .map((s) => (s.length > 0 ? s[0]?.toUpperCase() + s.slice(1) : ""))
    .join(" ");
  return content.replaceAll("__PROBLEM_ID__", problemId).replaceAll("__PROBLEM_NAME__", titleCase);
}

/**
 * Issue #954: 5 kind の対話用ラベル + 1 行の使い分け説明。 issue 本文の onboarding flow と
 * 揃える (= 「Flag Challenge / Uptime Battle / Multi-service Battle / Attack Detection /
 * Migration Battle」)。 「Migration Battle」 は phased-polling kind に対応する (= 段階的に
 * 移行する system を polling して各 phase の状態を採点する典型 use case)。
 */
const KIND_INTERACTIVE_LABELS: Record<Kind, string> = {
  flag: "Flag Challenge       — SSM Parameter / CFn output を flag として提出",
  "uptime-flat": "Uptime Flat Battle   — 1 endpoint × N cycles の SLA 測定",
  "uptime-multi": "Multi-service Battle — N endpoints × N cycles、 全 OK で加点",
  "phased-polling":
    "Migration Battle     — 時系列 phase で system 状態が遷移、 各 phase を polling",
  "attack-detection": "Attack Detection     — 攻撃を fire して participant が検出するかを採点",
};

/**
 * Issue #954: テスト容易性のため input / output を依存注入できる prompt インターフェース。
 * 本体は \`runInteractive\` が `node:readline/promises` で実装した default を渡す。
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
  const { ask, print } = prompts;
  print("=== TenkaCloud problem authoring (interactive) ===");
  print("");
  print("どの 種別 (= scoring kind) で問題を作成しますか?");
  const orderedKinds: readonly Kind[] = [
    "flag",
    "uptime-flat",
    "uptime-multi",
    "phased-polling",
    "attack-detection",
  ];
  orderedKinds.forEach((k, i) => {
    print(`  ${i + 1}) ${KIND_INTERACTIVE_LABELS[k]}`);
  });
  let kind: Kind | undefined;
  while (!kind) {
    const raw = (await ask("> 番号 (1-5) または kind 名: ")).trim();
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
      `  ✗ "${raw}" は無効です。 1-5 の番号か kind 名 (${KINDS.join(" / ")}) を入力してください。`,
    );
  }
  print(`  → kind: ${kind}`);
  print("");

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

  const categoryDir = effectiveCategory === "Battle" ? "battles" : "challenges";
  const outputRel = `problems/${categoryDir}/${problemId}/`;
  print("以下で scaffold を生成します:");
  print(`  - id:       ${problemId}`);
  print(`  - kind:     ${kind}`);
  print(`  - category: ${effectiveCategory}`);
  print(`  - 出力先:   ${outputRel}`);
  print("");
  const confirm = (await ask("作成しますか? [Y/n]: ")).trim().toLowerCase();
  if (confirm === "n" || confirm === "no") {
    print("中止しました (= ファイルは作成されていません)。");
    throw new Error("aborted by user");
  }

  const created = runCreate({
    problemId,
    kind,
    ...(category ? { category } : {}),
  });
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
  print(`  3. bun run scripts/tenkacloud-problem.ts validate ${problemId}`);
  print("  4. make validate-problems");
  print("");
  print("参照:");
  print("  - docs/problems/AUTHORING.html  (= 30 分 onboarding guide)");
  print("  - problems/SCHEMA.json          (= metadata.json schema)");
  print("  - /create-problem               (= Claude Code skill、 同等の対話を AI で進める)");

  return { created };
}

function findProblemDir(problemId: string): string | undefined {
  for (const category of ["battles", "challenges"]) {
    const candidate = join(PROBLEMS_ROOT, category, problemId);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface CreateResult {
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

interface ValidateResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function runValidate(problemId: string): ValidateResult {
  const dir = findProblemDir(problemId);
  if (!dir) {
    return { ok: false, errors: [`Problem dir not found for id="${problemId}"`] };
  }
  const errors: string[] = [];

  // 1) metadata.json が存在
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    errors.push("metadata.json not found");
    return { ok: false, errors };
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    errors.push(`metadata.json parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, errors };
  }

  // 2) id == dir 名
  if (meta.id !== problemId) {
    errors.push(`metadata.id="${String(meta.id)}" does not match dir name "${problemId}"`);
  }

  // 3) cfnTemplate が存在
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
  const templatePath = join(dir, cfnTemplate);
  if (!existsSync(templatePath)) {
    errors.push(`cfnTemplate file "${cfnTemplate}" not found in ${dir}`);
  }

  // 4) kind 別の追加 check
  const scoring = meta.scoring as Record<string, unknown> | undefined;
  const kind = scoring?.kind;
  if (typeof kind === "string") {
    if (!(KINDS as readonly string[]).includes(kind) && kind !== "uptime") {
      errors.push(`scoring.kind="${kind}" is not a recognized kind`);
    }
    // flag の flagOutputKey が template.yaml の Outputs にあるか確認
    if (kind === "flag" && existsSync(templatePath)) {
      const flagKey = scoring?.flagOutputKey;
      if (typeof flagKey === "string") {
        const yaml = readFileSync(templatePath, "utf8");
        if (!yaml.includes(`${flagKey}:`)) {
          errors.push(
            `scoring.flagOutputKey="${flagKey}" not found in template.yaml Outputs (= scoring engine が読めない)`,
          );
        }
      }
    }
    // attack-detection の statsOutputKey が Outputs にあるか
    if (kind === "attack-detection" && existsSync(templatePath)) {
      const statsKey = scoring?.statsOutputKey;
      if (typeof statsKey === "string") {
        const yaml = readFileSync(templatePath, "utf8");
        if (!yaml.includes(`${statsKey}:`)) {
          errors.push(`scoring.statsOutputKey="${statsKey}" not found in template.yaml Outputs`);
        }
      }
    }
  }

  // 5) endpoints[].default.key が template.yaml Outputs にあるか
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  if (endpoints.length > 0 && existsSync(templatePath)) {
    const yaml = readFileSync(templatePath, "utf8");
    for (const ep of endpoints as Array<Record<string, unknown>>) {
      const def = ep.default as Record<string, unknown> | undefined;
      const key = def?.key;
      if (typeof key === "string" && !yaml.includes(`${key}:`)) {
        errors.push(
          `endpoints[slot=${String(ep.slot)}].default.key="${key}" not found in template.yaml Outputs`,
        );
      }
    }
  }

  // 6) dashboard.slots の portal/<file>.tsx が物理 file として存在するか
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (slots) {
    for (const [slotName, slotPath] of Object.entries(slots)) {
      if (typeof slotPath === "string") {
        const physical = join(dir, slotPath);
        if (!existsSync(physical)) {
          errors.push(`dashboard.slots["${slotName}"]="${slotPath}" file not found at ${physical}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

interface DryRunResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: readonly string[];
}

/**
 * 問題の `metadata.scoring` を読んで、 与えられた input に対する得点を local 計算する。
 * 実 deploy 不要 (= scoring engine の Lambda 経路を回さない) で採点ロジックの妥当性を
 * 確認できる。 #951 sub #3。
 *
 * 対応 kind:
 *   - flag: --submitted <flag> + --reveal-hints <n>
 *   - uptime-flat: --cycles <N> + --pattern <s/f...> + --reveal-hints <n>
 *   - 他 kind: 「未対応」 を明示して exit 0 (= dry-run の存在自体は壊さない)
 */
export function runDryRun(args: {
  problemId: string;
  submitted?: string;
  revealHints?: number;
  cycles?: number;
  pattern?: string;
}): DryRunResult {
  const dir = findProblemDir(args.problemId);
  if (!dir) {
    return {
      ok: false,
      summary: `Problem dir not found for id="${args.problemId}"`,
      lines: [],
    };
  }
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    return { ok: false, summary: "metadata.json not found", lines: [] };
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  const scoring = (meta.scoring ?? {}) as Record<string, unknown>;
  const kind = String(scoring.kind ?? "");
  const lines: string[] = [];

  if (kind === "flag") {
    const expectedKey = scoring.flagOutputKey;
    const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
    const templatePath = join(dir, cfnTemplate);
    if (!existsSync(templatePath)) {
      return { ok: false, summary: `template ${cfnTemplate} not found`, lines };
    }
    const yaml = readFileSync(templatePath, "utf8");
    const expectedFlag = extractFlagFromTemplate(yaml, String(expectedKey));
    const points = Number(scoring.points ?? 0);
    const submitted = args.submitted ?? "";
    const correct = expectedFlag !== null && submitted === expectedFlag;
    const hintsRevealed = args.revealHints ?? 0;
    const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
    let penaltyTotal = 0;
    for (let i = 0; i < Math.min(hintsRevealed, hints.length); i += 1) {
      const h = hints[i] as Record<string, unknown> | string;
      const p = typeof h === "object" && h !== null ? Number(h.penalty ?? 0) : 0;
      penaltyTotal += p;
    }
    const earned = correct ? Math.max(0, points - penaltyTotal) : 0;

    lines.push(`kind:           flag`);
    lines.push(`flagOutputKey:  ${String(expectedKey)}`);
    lines.push(
      `expectedFlag:   ${expectedFlag === null ? "(could not extract from template — set Value directly to test)" : expectedFlag}`,
    );
    lines.push(`submitted:      ${submitted || "(empty)"}`);
    lines.push(`correct:        ${correct ? "yes" : "no"}`);
    lines.push(`baseline:       ${points} pt`);
    lines.push(`hintsRevealed:  ${hintsRevealed} (penalty -${penaltyTotal})`);
    lines.push(`earned:         ${earned} pt`);

    return {
      ok: true,
      summary: `flag dry-run: ${correct ? "正解" : "不正解"} → earned=${earned}`,
      lines,
    };
  }

  if (kind === "uptime-flat" || kind === "uptime") {
    const pointsPerSuccess = Number(scoring.pointsPerSuccess ?? 0);
    const failurePenalty = Number(scoring.failurePenalty ?? 0);
    const endpointsInScoring = Array.isArray(scoring.endpoints) ? scoring.endpoints : [];
    const endpointCount = endpointsInScoring.length;
    if (endpointCount === 0) {
      return {
        ok: false,
        summary: "uptime-flat metadata has no scoring.endpoints; cannot dry-run",
        lines,
      };
    }

    const cycles = args.cycles ?? 10;
    const pattern = args.pattern ?? "s".repeat(cycles);
    if (pattern.length !== cycles) {
      lines.push(
        `note: pattern length (${pattern.length}) !== cycles (${cycles}). Pattern を cycles に揃えるか、 cycles を pattern.length に合わせてください。`,
      );
    }

    let score = 0;
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < cycles; i += 1) {
      const sym = pattern[i % pattern.length];
      if (sym === "s") {
        score += pointsPerSuccess * endpointCount;
        okCount += 1;
      } else {
        score -= failurePenalty * endpointCount;
        failCount += 1;
      }
    }

    const hintsRevealed = args.revealHints ?? 0;
    const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
    let penaltyTotal = 0;
    for (let i = 0; i < Math.min(hintsRevealed, hints.length); i += 1) {
      const h = hints[i] as Record<string, unknown> | string;
      const p = typeof h === "object" && h !== null ? Number(h.penalty ?? 0) : 0;
      penaltyTotal += p;
    }
    const earned = Math.max(0, score - penaltyTotal);

    lines.push(`kind:             ${kind}`);
    lines.push(`endpoints:        ${endpointCount}`);
    lines.push(`pointsPerSuccess: ${pointsPerSuccess}`);
    lines.push(`failurePenalty:   ${failurePenalty}`);
    lines.push(`cycles:           ${cycles}`);
    lines.push(`pattern:          ${pattern} (s=success, f=fail)`);
    lines.push(`okCycles:         ${okCount}`);
    lines.push(`failCycles:       ${failCount}`);
    lines.push(`subtotal:         ${score} pt`);
    lines.push(`hintsRevealed:    ${hintsRevealed} (penalty -${penaltyTotal})`);
    lines.push(`earned:           ${earned} pt`);

    return {
      ok: true,
      summary: `${kind} dry-run: ${cycles} cycles → earned=${earned}`,
      lines,
    };
  }

  // Issue #951 sub #3: uptime-multi の dry-run。 全 slot probe で 全部 OK なら pointsAllOk
  // 加点、 1 つでも fail なら failurePenalty 減算。
  if (kind === "uptime-multi") {
    const pointsAllOk = Number(scoring.pointsAllOk ?? 0);
    const failurePenalty = Number(scoring.failurePenalty ?? 0);
    const probedSlots = Array.isArray(scoring.probedSlots) ? scoring.probedSlots : [];
    const slotCount = probedSlots.length;
    if (slotCount === 0) {
      return {
        ok: false,
        summary: "uptime-multi metadata has no scoring.probedSlots; cannot dry-run",
        lines,
      };
    }
    const cycles = args.cycles ?? 10;
    const pattern = args.pattern ?? "s".repeat(cycles);
    if (pattern.length !== cycles) {
      lines.push(
        `note: pattern length (${pattern.length}) !== cycles (${cycles})。 pattern を cycles に揃えてください。`,
      );
    }
    let score = 0;
    let allOkCycles = 0;
    let failCycles = 0;
    for (let i = 0; i < cycles; i += 1) {
      const sym = pattern[i % pattern.length];
      if (sym === "s") {
        score += pointsAllOk;
        allOkCycles += 1;
      } else {
        score -= failurePenalty;
        failCycles += 1;
      }
    }
    const hintsRevealed = args.revealHints ?? 0;
    const hintsList = Array.isArray(scoring.hints) ? scoring.hints : [];
    let hintPenalty = 0;
    for (let i = 0; i < Math.min(hintsRevealed, hintsList.length); i += 1) {
      const h = hintsList[i] as Record<string, unknown> | string;
      hintPenalty += typeof h === "object" && h !== null ? Number(h.penalty ?? 0) : 0;
    }
    const earned = Math.max(0, score - hintPenalty);
    lines.push(`kind:             uptime-multi`);
    lines.push(`probedSlots:      ${slotCount} (= 全 slot OK で加点)`);
    lines.push(`pointsAllOk:      ${pointsAllOk}`);
    lines.push(`failurePenalty:   ${failurePenalty}`);
    lines.push(`cycles:           ${cycles}`);
    lines.push(`pattern:          ${pattern} (s=全 slot OK, f=any fail)`);
    lines.push(`allOkCycles:      ${allOkCycles}`);
    lines.push(`failCycles:       ${failCycles}`);
    lines.push(`subtotal:         ${score} pt`);
    lines.push(`hintsRevealed:    ${hintsRevealed} (penalty -${hintPenalty})`);
    lines.push(`earned:           ${earned} pt`);
    return {
      ok: true,
      summary: `uptime-multi dry-run: ${cycles} cycles → earned=${earned}`,
      lines,
    };
  }

  // Issue #951 sub #3: phased-polling の dry-run。 platformRules を simulate するため、
  // `--pattern` には 「assumed platform per cycle」 を入れる (e.g. "eeeellll" = 4 cycles EC2 →
  // 4 cycles Lambda)。 phases[].afterMinutes に達した phase は platform effect が適用される
  // (= switchPlatformToDegraded で `degradedPoints` を使う等)。
  //
  // intervalMinutes=1 を仮定 (= 1 cycle = 1 minute)。 caller が intervalMinutes 不一致を必要なら
  // 別途調整。
  if (kind === "phased-polling") {
    const intervalMinutes = Number(scoring.intervalMinutes ?? 1);
    const platformRules = (scoring.platformRules ?? {}) as Record<string, Record<string, unknown>>;
    const cycles = args.cycles ?? 10;
    const pattern = args.pattern ?? "e".repeat(cycles); // default 全 cycle EC2 と仮定
    const phases = Array.isArray(meta.phases) ? meta.phases : [];
    if (pattern.length !== cycles) {
      lines.push(
        `note: pattern length (${pattern.length}) !== cycles (${cycles})。 1 char = 1 cycle に揃えてください。`,
      );
    }
    const platformChar: Record<string, string> = {
      e: "ec2",
      l: "lambda",
      c: "ecs",
      a: "apprunner",
    };
    let score = 0;
    const cycleLog: string[] = [];
    for (let i = 0; i < cycles; i += 1) {
      const sym = pattern[i % pattern.length] ?? "e";
      const platform = platformChar[sym] ?? "ec2";
      const minutesElapsed = (i + 1) * intervalMinutes;
      const degradedPlatforms = new Set<string>();
      for (const ph of phases as Array<Record<string, unknown>>) {
        const after = Number(ph.afterMinutes ?? 0);
        if (minutesElapsed >= after) {
          const effect = ph.effect as Record<string, unknown> | undefined;
          const list = effect?.switchPlatformToDegraded;
          if (Array.isArray(list)) for (const p of list) degradedPlatforms.add(String(p));
        }
      }
      const rule = platformRules[platform] ?? {};
      const pointsFull = Number(rule.points ?? 0);
      const pointsDegraded = Number(rule.degradedPoints ?? 0);
      const earnedThis = degradedPlatforms.has(platform) ? pointsDegraded : pointsFull;
      score += earnedThis;
      cycleLog.push(
        `  cycle ${i + 1}/${cycles} (minute ${minutesElapsed}) platform=${platform} ${
          degradedPlatforms.has(platform) ? "(DEGRADED)" : ""
        } → +${earnedThis}`,
      );
    }
    lines.push(`kind:           phased-polling`);
    lines.push(`intervalMin:    ${intervalMinutes}`);
    lines.push(`platforms:      ${Object.keys(platformRules).join(", ")}`);
    lines.push(`phases:         ${phases.length}`);
    lines.push(`pattern:        ${pattern} (e=ec2, l=lambda, c=ecs, a=apprunner)`);
    lines.push(...cycleLog);
    lines.push(`earned:         ${score} pt`);
    return {
      ok: true,
      summary: `phased-polling dry-run: ${cycles} cycles → earned=${score}`,
      lines,
    };
  }

  // Issue #951 sub #3: attack-detection の dry-run。 counter は cycle ごとに増加する想定で、
  // pattern で 各 cycle の increment を 1 char で表現する (= 0-9)。
  if (kind === "attack-detection") {
    const pointsPerAttack = Number(scoring.pointsPerAttack ?? 0);
    const cycles = args.cycles ?? 10;
    const pattern = args.pattern ?? "1".repeat(cycles); // default 各 cycle で +1 attack
    if (pattern.length !== cycles) {
      lines.push(
        `note: pattern length (${pattern.length}) !== cycles (${cycles})。 1 char (0-9) = その cycle で何件 +increment したかを表す。`,
      );
    }
    let totalDelta = 0;
    let score = 0;
    const cycleLog: string[] = [];
    for (let i = 0; i < cycles; i += 1) {
      const ch = pattern[i % pattern.length] ?? "0";
      const delta = Number.parseInt(ch, 10);
      if (!Number.isFinite(delta) || delta < 0 || delta > 9) {
        cycleLog.push(`  cycle ${i + 1}: invalid char "${ch}" → skip`);
        continue;
      }
      totalDelta += delta;
      const earnedThis = delta * pointsPerAttack;
      score += earnedThis;
      cycleLog.push(
        `  cycle ${i + 1}: +${delta} detections (×${pointsPerAttack}) → +${earnedThis}`,
      );
    }
    lines.push(`kind:           attack-detection`);
    lines.push(`pointsPerAttack: ${pointsPerAttack}`);
    lines.push(`pattern:        ${pattern} (1 char = increment per cycle, 0-9)`);
    lines.push(...cycleLog);
    lines.push(`totalDetections: ${totalDelta}`);
    lines.push(`earned:         ${score} pt`);
    return {
      ok: true,
      summary: `attack-detection dry-run: ${cycles} cycles, total ${totalDelta} detections → earned=${score}`,
      lines,
    };
  }

  // それでも未対応の kind (= 将来追加分)
  lines.push(`kind="${kind}" の dry-run は未対応です (= 将来 kind 追加時に拡張)`);
  return { ok: true, summary: `kind=${kind} dry-run unsupported`, lines };
}

/**
 * CFn YAML から Output `key:` 配下の `Value:` を抽出する素朴 parser。
 * `Value: "TC{...}"` / `Value: !GetAtt X.Value` の前者だけハンドルする。
 * 後者は実 deploy しないと値が解決しないため null を返す。
 */
/**
 * Issue #951 sub #5: problem author 向け debug inspector。
 *
 * 旧状態: 問題作成者が 「scoring engine が自分の問題をどう読んでいるか」 を確認するには
 * metadata.json / template.yaml / portal/ を別々に grep する必要があった。 採点が想定通り動かない
 * とき、 どこで詰まっているか切り分けるのに時間が掛かる (= 「scoring kind は flag だが flagOutputKey
 * が typo で template Outputs に無い」 のような bug を deploy 前に発見する経路が無い)。
 *
 * 本 inspect subcommand は metadata + template + portal slot を resolve し、 1 引きで dump する:
 *
 *   - metadata.json から id / kind / scoring / endpoints / phases / disruptions / dashboard.slots
 *   - template.yaml から Resources / Parameters / Outputs の一覧 + 必須 ParticipantViewerRole 検査
 *   - scoring engine が読む key (= flagOutputKey / statsOutputKey / endpoints[].default.key) と
 *     Outputs の cross-ref を一覧表示
 *   - portal/ ディレクトリの slot file (= dashboard.slots で declared された tsx) の存在確認
 *
 * `make validate-problems` と違って 「正しいか」 ではなく 「何が見えているか」 を吐く。 author の
 * mental model 確認用。
 */
export interface InspectResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: readonly string[];
}

export function runInspect(args: { problemId: string }): InspectResult {
  const dir = findProblemDir(args.problemId);
  if (!dir) {
    return { ok: false, summary: `Problem dir not found for id="${args.problemId}"`, lines: [] };
  }
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    return { ok: false, summary: "metadata.json not found", lines: [] };
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  const lines: string[] = [];

  lines.push(`=== Problem ${args.problemId} ===`);
  lines.push(`directory:        ${dir.replace(REPO_ROOT, "")}`);
  lines.push(`name:             ${String(meta.name ?? "(none)")}`);
  lines.push(`category:         ${String(meta.category ?? "(none)")}`);
  lines.push(`status:           ${String(meta.status ?? "(none)")}`);
  lines.push(`visibility:       ${String(meta.visibility ?? "public")}`);
  lines.push(`difficulty:       ${String(meta.difficulty ?? "(none)")}`);
  lines.push(`estimatedDuration: ${String(meta.estimatedDuration ?? "(none)")}`);
  lines.push("");

  // scoring
  const scoring = (meta.scoring ?? {}) as Record<string, unknown>;
  const kind = String(scoring.kind ?? "");
  lines.push(`--- Scoring engine view ---`);
  lines.push(`kind:             ${kind || "(none)"}`);
  if (kind === "flag") {
    lines.push(`flagOutputKey:    ${String(scoring.flagOutputKey ?? "(missing)")}`);
    lines.push(`points:           ${String(scoring.points ?? "(missing)")}`);
    if (scoring.wrongAnswerPenalty)
      lines.push(`wrongAnswerPenalty: ${String(scoring.wrongAnswerPenalty)}`);
  } else if (kind === "uptime-flat" || kind === "uptime") {
    const eps = Array.isArray(scoring.endpoints) ? scoring.endpoints : [];
    lines.push(`endpoints:        ${eps.length}`);
    for (const ep of eps as Array<Record<string, unknown>>) {
      lines.push(
        `                  - slot=${String(ep.slot ?? "?")} path=${String(ep.path ?? "?")} expect=${JSON.stringify(ep.expectStatus ?? [])}`,
      );
    }
    lines.push(`pointsPerSuccess: ${String(scoring.pointsPerSuccess ?? "(missing)")}`);
    if (scoring.failurePenalty !== undefined)
      lines.push(`failurePenalty:   ${String(scoring.failurePenalty)}`);
  } else if (kind === "uptime-multi") {
    const slots = Array.isArray(scoring.probedSlots) ? scoring.probedSlots : [];
    lines.push(`probedSlots:      ${slots.length} (= 全部 OK で加点)`);
    for (const s of slots as Array<Record<string, unknown>>) {
      lines.push(
        `                  - slot=${String(s.slot ?? "?")} path=${String(s.path ?? "?")} expect=${JSON.stringify(s.expectStatus ?? [])}`,
      );
    }
    lines.push(`pointsAllOk:      ${String(scoring.pointsAllOk ?? "(missing)")}`);
    lines.push(`failurePenalty:   ${String(scoring.failurePenalty ?? "0")}`);
  } else if (kind === "phased-polling") {
    lines.push(`intervalMinutes:  ${String(scoring.intervalMinutes ?? "(missing)")}`);
    const platforms = scoring.platformRules as Record<string, unknown> | undefined;
    lines.push(`platformRules:    ${platforms ? Object.keys(platforms).join(", ") : "(missing)"}`);
    const probe = scoring.probe as Record<string, unknown> | undefined;
    lines.push(
      `probe paths:      meta=${String(probe?.metaPath ?? "?")} score=${String(probe?.scorePath ?? "?")}`,
    );
  } else if (kind === "attack-detection") {
    lines.push(`statsOutputKey:   ${String(scoring.statsOutputKey ?? "(missing)")}`);
    lines.push(`pointsPerAttack:  ${String(scoring.pointsPerAttack ?? "(missing)")}`);
  }
  // hints (= 全 kind)
  const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
  if (hints.length > 0) {
    lines.push(`hints:            ${hints.length} 件`);
    hints.forEach((h, i) => {
      if (typeof h === "string") {
        lines.push(`                  [${i + 1}] (legacy v1, penalty=0) ${h.slice(0, 60)}…`);
      } else if (h && typeof h === "object") {
        const ho = h as Record<string, unknown>;
        lines.push(
          `                  [${i + 1}] id=${String(ho.id)} penalty=${String(ho.penalty)} content="${String(ho.content).slice(0, 50)}…"`,
        );
      }
    });
  }
  lines.push("");

  // endpoints (= metadata.endpoints、 scoring.endpoints とは別軸の registry)
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  if (endpoints.length > 0) {
    lines.push(`--- Endpoint registry (= metadata.endpoints) ---`);
    for (const ep of endpoints as Array<Record<string, unknown>>) {
      const def = ep.default as Record<string, unknown> | undefined;
      lines.push(
        `  slot=${String(ep.slot)} default-from=${String(def?.from ?? "?")} default-key=${String(def?.key ?? "?")} overridable=${String(ep.overridable ?? false)}`,
      );
    }
    lines.push("");
  }

  // phases
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  if (phases.length > 0) {
    lines.push(`--- Phases ---`);
    for (const ph of phases as Array<Record<string, unknown>>) {
      lines.push(
        `  name=${String(ph.name)} afterMinutes=${String(ph.afterMinutes ?? "?")} effect=${JSON.stringify(ph.effect ?? {})}`,
      );
    }
    lines.push("");
  }

  // disruptions
  const disruptions = Array.isArray(meta.disruptions) ? meta.disruptions : [];
  if (disruptions.length > 0) {
    lines.push(`--- Disruptions ---`);
    for (const d of disruptions as Array<Record<string, unknown>>) {
      lines.push(
        `  id=${String(d.id)} name=${String(d.name)} default=${String(d.defaultAfterMinutes ?? "?")}min`,
      );
    }
    lines.push("");
  }

  // dashboard.slots
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (slots) {
    lines.push(`--- Portal slots ---`);
    for (const [slot, file] of Object.entries(slots)) {
      const physical = join(dir, String(file));
      const exists = existsSync(physical);
      lines.push(`  ${slot}: ${String(file)} ${exists ? "(OK)" : "(MISSING!)"}`);
    }
    lines.push("");
  }

  // template.yaml の inspection (= check-template-cfn-refs と同 line-by-line parser)
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
  const templatePath = join(dir, cfnTemplate);
  if (existsSync(templatePath)) {
    const yaml = readFileSync(templatePath, "utf8");
    lines.push(`--- Template (${cfnTemplate}) ---`);
    const yamlLines = yaml.split(/\r?\n/);
    const resourceNames: string[] = [];
    const outputNames: string[] = [];
    const parameterNames: string[] = [];
    let section: "resources" | "parameters" | "outputs" | null = null;
    for (const line of yamlLines) {
      if (/^Resources:\s*$/.test(line)) {
        section = "resources";
        continue;
      }
      if (/^Parameters:\s*$/.test(line)) {
        section = "parameters";
        continue;
      }
      if (/^Outputs:\s*$/.test(line)) {
        section = "outputs";
        continue;
      }
      if (/^[A-Za-z]/.test(line) && line.endsWith(":")) {
        section = null;
        continue;
      }
      if (!section) continue;
      const m = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/);
      if (!m?.[1]) continue;
      if (section === "resources") resourceNames.push(m[1]);
      else if (section === "outputs") outputNames.push(m[1]);
      else if (section === "parameters") parameterNames.push(m[1]);
    }
    lines.push(`  Parameters: ${parameterNames.join(", ") || "(none)"}`);
    lines.push(`  Resources:  ${resourceNames.join(", ") || "(none)"}`);
    lines.push(`  Outputs:    ${outputNames.join(", ") || "(none)"}`);

    // Cross-ref check (= 各 key が Outputs に存在するか + 必須 ParticipantViewerRole 等)
    const crossRefIssues: string[] = [];
    if (kind === "flag") {
      const k = String(scoring.flagOutputKey ?? "");
      if (k && !outputNames.includes(k)) crossRefIssues.push(`flagOutputKey="${k}" not in Outputs`);
    }
    if (kind === "attack-detection") {
      const k = String(scoring.statsOutputKey ?? "");
      if (k && !outputNames.includes(k))
        crossRefIssues.push(`statsOutputKey="${k}" not in Outputs`);
    }
    for (const ep of endpoints as Array<Record<string, unknown>>) {
      const def = ep.default as Record<string, unknown> | undefined;
      if (
        def?.from === "cfn-output" &&
        typeof def.key === "string" &&
        !outputNames.includes(def.key)
      ) {
        crossRefIssues.push(
          `endpoints[slot=${String(ep.slot)}].default.key="${def.key}" not in Outputs`,
        );
      }
    }
    if (!resourceNames.includes("ParticipantViewerRole")) {
      crossRefIssues.push("ParticipantViewerRole resource not declared (= ADR-002 Phase 2.1)");
    }
    if (!outputNames.includes("ParticipantViewerRoleArn")) {
      crossRefIssues.push("ParticipantViewerRoleArn output not declared (= sso.ts が読む)");
    }
    if (crossRefIssues.length > 0) {
      lines.push(`  Cross-ref issues:`);
      for (const issue of crossRefIssues) lines.push(`    ✗ ${issue}`);
    } else {
      lines.push(`  Cross-ref:  OK (= all scoring / endpoint keys resolve to Outputs)`);
    }
  } else {
    lines.push(`  Template "${cfnTemplate}" NOT FOUND`);
  }

  return { ok: true, summary: `inspect ${args.problemId} (kind=${kind})`, lines };
}

function extractFlagFromTemplate(yaml: string, key: string): string | null {
  const re = new RegExp(`${key}:[\\s\\S]*?Value:\\s*("[^"\\n]+"|'[^'\\n]+'|[^\\n!]+)\\n`, "m");
  const m = yaml.match(re);
  if (!m || !m[1]) return null;
  const raw = m[1].trim();
  if (raw.startsWith("!")) return null;
  return raw.replace(/^["']|["']$/g, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "list-kinds":
      listKinds();
      return;
    case "interactive": {
      // Issue #954: stdin / stdout を持つ default prompts で対話モード起動。
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await runInteractive({
          ask: (q) => rl.question(q),
          print: (line) => console.log(line),
        });
      } finally {
        rl.close();
      }
      return;
    }
    case "create": {
      if (!args.kind) {
        throw new Error("create requires --kind <kind>. Use 'list-kinds' to see options.");
      }
      const r = runCreate({
        problemId: args.problemId ?? "",
        kind: args.kind,
        ...(args.category ? { category: args.category } : {}),
      });
      console.log(
        `Created ${r.outputDir}\n  category: ${r.category}\n  kind:     ${r.kind}\n\nNext steps:\n  1. Edit ${r.outputDir}/metadata.json (name / description / tags / learningGoals)\n  2. Edit ${r.outputDir}/template.yaml (実 AWS リソース)\n  3. bun run scripts/tenkacloud-problem.ts validate ${args.problemId}\n  4. make validate-problems`,
      );
      return;
    }
    case "validate": {
      const r = runValidate(args.problemId ?? "");
      if (r.ok) {
        console.log(`OK ${args.problemId}`);
      } else {
        console.error(`NG ${args.problemId}:`);
        for (const e of r.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      return;
    }
    case "dry-run": {
      const r = runDryRun({
        problemId: args.problemId ?? "",
        ...(args.submitted !== undefined ? { submitted: args.submitted } : {}),
        ...(args.revealHints !== undefined ? { revealHints: args.revealHints } : {}),
        ...(args.cycles !== undefined ? { cycles: args.cycles } : {}),
        ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
      });
      if (!r.ok) {
        console.error(`NG ${r.summary}`);
        process.exit(1);
      }
      for (const line of r.lines) console.log(line);
      console.log(`\nsummary: ${r.summary}`);
      return;
    }
    case "inspect": {
      const r = runInspect({ problemId: args.problemId ?? "" });
      if (!r.ok) {
        console.error(`NG ${r.summary}`);
        process.exit(1);
      }
      for (const line of r.lines) console.log(line);
      return;
    }
    default: {
      const _exhaustive: never = args.command;
      throw new Error(`unhandled command: ${String(_exhaustive)}`);
    }
  }
}

// CLI 起動と test import を区別するため main module check。
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
