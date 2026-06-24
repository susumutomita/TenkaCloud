#!/usr/bin/env bun
/**
 * 問題 template.yaml が AWS の 64 文字上限を持つ物理名を `${NamePrefix}` 込みで明示宣言
 * していないか検査する (#1812 class の regression 防止)。
 *
 * 背景: `NamePrefix = tc-{slug(problemId)[:40]}-{slug(teamName)[:40]}` は最大 84 文字に
 * なり得る。 IAM `RoleName` / Lambda `FunctionName` は **64 文字上限**のため、 長い team 名で
 * `RoleName: !Sub "${NamePrefix}-..."` が CFn deploy 時に CREATE_FAILED する。 これは
 * `cdk synth` / lint / `validate-problems` を全て通過するため、 merge 後の deploy で初めて
 * 静かに落ちる class (= em-dash #664/#70・UserData 16KB #76 と同じ 「synth は通るが deploy で
 * 落ちる CFn 制約」)。
 *
 * 修正方針 (#1812): 明示 `RoleName` / `FunctionName` を削除する。 CloudFormation が上限内に
 * 収まる物理名を自動生成し、 consumer は `!GetAtt <Resource>.Arn` (= 名前非依存) を Output
 * 経由で読むため安全。 予測可能な log group 名が要る場合は `LoggingConfig.LogGroup` +
 * 明示 `AWS::Logs::LogGroup` (LogGroupName 上限 512、 NamePrefix でも overflow しない) を使う。
 *
 * 検出ルール:
 *   - 各行が `^<indent>RoleName:` または `^<indent>FunctionName:` の **key** で、 かつ
 *     値 (= 行の残り) に `${NamePrefix}` を含む場合に flag する。
 *   - `XxxRoleName:` のように key の末尾が一致するだけの property は除外 (key 全体一致)。
 *   - `LogGroupName` (512) / `ManagedPolicyName` (128) など上限に余裕がある物理名は対象外。
 *
 * `make before-commit` の check 群に加える。 fail-fast (exit 1) で問題作成者に早期 feedback。
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Run from the repo root (pre-commit hook / CI / `/quality-gates` skill all do).
const REPO_ROOT = process.cwd();
const PROBLEMS_DIR = join(REPO_ROOT, "problems");

/** 64 文字上限を持つ物理名 property (= `${NamePrefix}` 込みで overflow し得る)。 */
const OVERFLOWABLE_NAME_PROPERTIES = ["RoleName", "FunctionName"] as const;

export interface NameFinding {
  /** 1-origin の行番号。 */
  readonly line: number;
  readonly property: (typeof OVERFLOWABLE_NAME_PROPERTIES)[number];
  /** flag した行 (trim 済)。 */
  readonly text: string;
}

/**
 * yaml 文字列から `${NamePrefix}` 込みの `RoleName:` / `FunctionName:` 宣言を抽出する。
 * CFn の `!Sub` 等の tag をそのまま扱うため YAML loader は使わず行ベースで走査する
 * (= check-template-cfn-refs / cli-access と同方針)。
 */
export function findNameLimitFindings(yaml: string): NameFinding[] {
  const findings: NameFinding[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const property of OVERFLOWABLE_NAME_PROPERTIES) {
      // key 全体一致 (= 先頭は空白のみ、 直後は ":")。 `XxxRoleName:` を誤検出しない。
      const keyMatch = new RegExp(`^\\s*${property}:`).test(line);
      if (!keyMatch) continue;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub の literal token を検出対象として照合する意図
      if (!line.includes("${NamePrefix}")) continue;
      findings.push({ line: i + 1, property, text: line.trim() });
    }
  }
  return findings;
}

interface FileFindings {
  readonly templatePath: string;
  readonly findings: readonly NameFinding[];
}

export function checkTemplate(templatePath: string): FileFindings | undefined {
  const yaml = readFileSync(templatePath, "utf8");
  const findings = findNameLimitFindings(yaml);
  return findings.length > 0 ? { templatePath, findings } : undefined;
}

function findTemplates(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "template.yaml" || entry === "template.yml") out.push(full);
    }
  };
  walk(PROBLEMS_DIR);
  return out;
}

function main(): void {
  const templates = findTemplates();
  if (templates.length === 0) {
    console.log("No template.yaml found under problems/.");
    return;
  }
  const all: FileFindings[] = [];
  for (const tpl of templates) {
    const r = checkTemplate(tpl);
    if (r) all.push(r);
  }
  if (all.length === 0) {
    console.log(
      `OK: ${templates.length} template(s) スキャン、` +
        " 64 文字上限の物理名 (RoleName / FunctionName) を NamePrefix 込みで明示宣言した箇所なし (#1812)",
    );
    return;
  }
  for (const f of all) {
    const rel = relative(REPO_ROOT, f.templatePath);
    for (const n of f.findings) {
      console.error(
        `NG ${rel}:${n.line}: ${n.property} が \${NamePrefix} 込みの明示名 — ` +
          "NamePrefix は最大 84 文字で 64 文字上限を超え deploy が CREATE_FAILED します (#1812)",
      );
      console.error(`    ${n.text}`);
    }
  }
  console.error("");
  console.error(
    "修正方法: 明示 RoleName / FunctionName を削除し CloudFormation の自動命名に任せてください。",
  );
  console.error(
    "  consumer は !GetAtt <Resource>.Arn (= 名前非依存) を Output 経由で読むため安全です。",
  );
  console.error(
    "  予測可能な log group 名が要る場合は LoggingConfig.LogGroup + 明示 AWS::Logs::LogGroup",
  );
  console.error("  (LogGroupName 上限 512) を使ってください。");
  process.exit(1);
}

if (import.meta.main) main();
