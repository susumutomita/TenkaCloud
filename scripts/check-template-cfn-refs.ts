#!/usr/bin/env bun
/**
 * Issue #951 sub #2: 問題 template.yaml の構造的整合性チェック (cfn-lint port lite)。
 *
 * 旧状態: `make validate-problems` は metadata.json の SCHEMA 検証 + cross-ref
 * (= scoring.flagOutputKey ↔ Outputs / endpoints[].default.key ↔ Outputs) のみ。
 * CFn template 内部の `!Ref` / `!GetAtt` が未宣言の resource を指していても deploy 時まで
 * 気付けず、 問題作成者の開発サイクルが (= edit → make deploy 5-10 分 → 失敗) で長い。
 *
 * 本 script は問題テンプレートに限定した軽量 cfn-lint:
 *
 *   - `!Ref <name>` / `Fn::Ref: <name>` が `Resources.<name>` か `Parameters.<name>` か
 *     pseudo parameter (= `AWS::*`) に解決できるか
 *   - `!GetAtt <Resource>.<Attr>` の `<Resource>` 部分が `Resources` に declared か
 *   - `!Sub "${VarName}"` 内の `${...}` 参照が同様に解決できるか
 *   - 必須 Resource 規約: 全 problem template で `ParticipantViewerRole` (= AWS::IAM::Role) と
 *     その Outputs `ParticipantViewerRoleArn` (= ADR-002 Phase 2.1) が宣言されているか
 *
 * 検出されたら exit 1。 `make validate-problems` の後段で呼ぶ。
 *
 * Python cfn-lint 同等の網羅性は持たない (= 意図的に小さく、 deploy 前に検出すべき
 * top 80% を狙う)。 IAM policy 細部や resource type 別 attribute は AWS 側 deploy 時に
 * 任せる。
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBLEMS_DIR = join(REPO_ROOT, "problems");

interface Finding {
  readonly templatePath: string;
  readonly rule: string;
  readonly detail: string;
}

/**
 * AWS pseudo parameters。 `!Ref` で参照可能だが Resources / Parameters には declared されない。
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/pseudo-parameter-reference.html
 */
const PSEUDO_PARAMETERS = new Set([
  "AWS::AccountId",
  "AWS::NotificationARNs",
  "AWS::NoValue",
  "AWS::Partition",
  "AWS::Region",
  "AWS::StackId",
  "AWS::StackName",
  "AWS::URLSuffix",
]);

/**
 * 必須宣言の resource 名 + Outputs key (= ADR-002 Phase 2.1)。 sso.ts が
 * ParticipantViewerRoleArn を読むため、 全 problem template で declare 必須。
 */
const REQUIRED_RESOURCE_NAMES = ["ParticipantViewerRole"] as const;
const REQUIRED_OUTPUT_KEYS = ["ParticipantViewerRoleArn"] as const;

/**
 * YAML を line-by-line で section 別に分割する単純な parser。 完全な YAML AST は使わない (= 短文・
 * tab/空白 mix の防御に弱い既存 YAML library 依存を避ける)。 各 section の resource / parameter / output
 * 名は `^  <Name>:` (= 2-space indent) で declare されているという CFn 慣例を前提に抽出する。
 */
function parseSections(yaml: string): {
  resources: Set<string>;
  parameters: Set<string>;
  outputs: Set<string>;
} {
  const lines = yaml.split(/\r?\n/);
  const resources = new Set<string>();
  const parameters = new Set<string>();
  const outputs = new Set<string>();
  let currentSection: "resources" | "parameters" | "outputs" | null = null;

  for (const line of lines) {
    // Top-level section header (= `Resources:` / `Parameters:` / `Outputs:` at column 0)
    if (/^Resources:\s*$/.test(line)) {
      currentSection = "resources";
      continue;
    }
    if (/^Parameters:\s*$/.test(line)) {
      currentSection = "parameters";
      continue;
    }
    if (/^Outputs:\s*$/.test(line)) {
      currentSection = "outputs";
      continue;
    }
    // 次の top-level section に入ったら終了 (= column 0 の `<Section>:` で抜ける)
    if (/^[A-Za-z]/.test(line) && line.endsWith(":")) {
      currentSection = null;
      continue;
    }
    if (!currentSection) continue;
    // Section 内の `  <Name>:` (= 2-space indent + identifier + `:`) を拾う
    const m = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/);
    if (!m?.[1]) continue;
    const name = m[1];
    if (currentSection === "resources") resources.add(name);
    if (currentSection === "parameters") parameters.add(name);
    if (currentSection === "outputs") outputs.add(name);
  }
  return { resources, parameters, outputs };
}

/**
 * `!Ref <name>` / `Ref: <name>` を YAML テキストから抽出する。 `<name>` は英数 + `_` のみ。
 */
function collectRefs(yaml: string): string[] {
  const refs: string[] = [];
  // !Ref shortform
  for (const m of yaml.matchAll(/!Ref\s+([A-Za-z][A-Za-z0-9:_]*)/g)) {
    if (m[1]) refs.push(m[1]);
  }
  // Long form `Ref: <Name>` (= JSON-shape の Fn::Ref)
  for (const m of yaml.matchAll(/^\s*Ref:\s+([A-Za-z][A-Za-z0-9:_]*)\s*$/gm)) {
    if (m[1]) refs.push(m[1]);
  }
  return refs;
}

/**
 * `!GetAtt <Resource>.<Attr>` から resource 部分を抽出する。
 * 関数形 (`Fn::GetAtt: [Resource, Attr]`) も対応するが、 主に short form のみ検出。
 */
function collectGetAttResources(yaml: string): string[] {
  const out: string[] = [];
  for (const m of yaml.matchAll(/!GetAtt\s+([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9.]*)/g)) {
    if (m[1]) out.push(m[1]);
  }
  // Long form: Fn::GetAtt: [ Resource, Attr ]
  for (const m of yaml.matchAll(/Fn::GetAtt:\s*\[\s*([A-Za-z][A-Za-z0-9]*)\s*,/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * `!Sub "${VarName}"` 内の `${...}` 参照を抽出する。 `${VarName}` (= Ref) / `${Resource.Attr}` (= GetAtt) / `${!Literal}` (= escape) を区別する。
 */
function collectSubRefs(yaml: string): { refs: string[]; getAtts: string[] } {
  const refs: string[] = [];
  const getAtts: string[] = [];
  // `!Sub "..."` または `Fn::Sub:` の右辺を行ごとに拾う簡易版。 multi-line "|" Sub も含めて検出
  // しやすいよう、 `${...}` を yaml 全体から拾い、 `!Sub` line context は問わない (= false-positive
  // のリスクはあるが、 problem template の安全側 default として ${...} が出現したら必ず Ref / GetAtt
  // と扱う方が漏れにくい)。
  const re = /\$\{([^}]+)\}/g;
  for (const m of yaml.matchAll(re)) {
    const expr = m[1];
    if (!expr) continue;
    if (expr.startsWith("!")) continue; // ${!Literal} は escape、 reference でない
    if (expr.includes(".")) {
      const head = expr.split(".")[0];
      if (head) getAtts.push(head);
    } else {
      refs.push(expr);
    }
  }
  return { refs, getAtts };
}

function checkTemplate(templatePath: string): Finding[] {
  const findings: Finding[] = [];
  const yaml = readFileSync(templatePath, "utf8");
  const { resources, parameters, outputs } = parseSections(yaml);

  // 必須 Resource / Output (= ADR-002 Phase 2.1)
  for (const required of REQUIRED_RESOURCE_NAMES) {
    if (!resources.has(required)) {
      findings.push({
        templatePath,
        rule: "required-resource-missing",
        detail: `Resources.${required} is required (= ADR-002 Phase 2.1: 全 problem template で参加者 federation 用 Role を宣言する)`,
      });
    }
  }
  for (const required of REQUIRED_OUTPUT_KEYS) {
    if (!outputs.has(required)) {
      findings.push({
        templatePath,
        rule: "required-output-missing",
        detail: `Outputs.${required} is required (= sso.ts handler が読む key)`,
      });
    }
  }

  // !Ref / Ref: の resolve
  const directRefs = collectRefs(yaml);
  const subRefs = collectSubRefs(yaml);
  const allRefs = [...directRefs, ...subRefs.refs];
  for (const ref of allRefs) {
    if (PSEUDO_PARAMETERS.has(ref)) continue;
    if (resources.has(ref) || parameters.has(ref)) continue;
    findings.push({
      templatePath,
      rule: "unresolved-ref",
      detail: `Ref: ${ref} — not declared in Resources / Parameters / pseudo`,
    });
  }

  // !GetAtt の resource 部分
  const getAttResources = [...collectGetAttResources(yaml), ...subRefs.getAtts];
  for (const r of getAttResources) {
    if (PSEUDO_PARAMETERS.has(r)) continue;
    if (resources.has(r) || parameters.has(r)) continue;
    findings.push({
      templatePath,
      rule: "unresolved-getatt-resource",
      detail: `GetAtt ${r}.* — resource not declared`,
    });
  }

  return findings;
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
  const allFindings: Finding[] = [];
  for (const tpl of templates) {
    allFindings.push(...checkTemplate(tpl));
  }
  if (allFindings.length === 0) {
    console.log(
      `OK: ${templates.length} template(s) スキャン、 CFn ref / 必須 resource 違反 0 件 (= !Ref / !GetAtt 解決済、 ParticipantViewerRole 宣言済)`,
    );
    return;
  }
  for (const f of allFindings) {
    const rel = relative(REPO_ROOT, f.templatePath);
    console.error(`NG ${rel} [${f.rule}] ${f.detail}`);
  }
  console.error(`\n${allFindings.length} finding(s) across ${templates.length} template(s)`);
  process.exit(1);
}

main();
