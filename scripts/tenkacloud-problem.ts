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
  command: "create" | "validate" | "list-kinds" | "help";
  problemId?: string;
  kind?: Kind;
  category?: "Battle" | "Challenge";
}

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help" };
  }
  const command = argv[0];
  if (command === "list-kinds") return { command };
  if (command !== "create" && command !== "validate") {
    throw new Error(`unknown command: ${command}. Try 'help', 'list-kinds', 'create', 'validate'.`);
  }
  const problemId = argv[1];
  if (!problemId) throw new Error(`${command} requires <problemId>`);
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
  bun run scripts/tenkacloud-problem.ts validate <id>
  bun run scripts/tenkacloud-problem.ts list-kinds

Available kinds:  ${KINDS.join(", ")}

Examples:
  bun run scripts/tenkacloud-problem.ts create my-battle --kind uptime-multi
  bun run scripts/tenkacloud-problem.ts create hello-flag --kind flag
  bun run scripts/tenkacloud-problem.ts validate microservice-migration-battle

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "list-kinds":
      listKinds();
      return;
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
