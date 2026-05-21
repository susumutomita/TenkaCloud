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

type CfnSection = "resources" | "parameters" | "outputs";

const SECTION_HEADER_RE: Record<CfnSection, RegExp> = {
  resources: /^Resources:\s*$/,
  parameters: /^Parameters:\s*$/,
  outputs: /^Outputs:\s*$/,
};
const OTHER_TOP_LEVEL_SECTION_RE = /^[A-Za-z][^:]*:\s*$/;
const INDENTED_NAME_RE = /^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/;

/**
 * `Resources:` / `Parameters:` / `Outputs:` のいずれか、 または他の top-level section header
 * (= 既知 section を抜ける合図) を 1 行から検出する。
 *
 * - 該当 section に入る場合: そのキー
 * - 他の top-level に入る場合: "exit" (= currentSection を null に倒す)
 * - section header でない (= 内容行) 場合: null
 */
function detectSectionHeader(line: string): CfnSection | "exit" | null {
  for (const section of ["resources", "parameters", "outputs"] as const) {
    if (SECTION_HEADER_RE[section].test(line)) return section;
  }
  if (OTHER_TOP_LEVEL_SECTION_RE.test(line)) return "exit";
  return null;
}

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
  const buckets: Record<CfnSection, Set<string>> = {
    resources: new Set<string>(),
    parameters: new Set<string>(),
    outputs: new Set<string>(),
  };
  let currentSection: CfnSection | null = null;

  for (const line of yaml.split(/\r?\n/)) {
    const header = detectSectionHeader(line);
    if (header === "exit") {
      currentSection = null;
      continue;
    }
    if (header) {
      currentSection = header;
      continue;
    }
    if (!currentSection) continue;
    const name = INDENTED_NAME_RE.exec(line)?.[1];
    if (name) buckets[currentSection].add(name);
  }
  return buckets;
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

function checkRequiredDeclarations(
  templatePath: string,
  resources: Set<string>,
  outputs: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const required of REQUIRED_RESOURCE_NAMES) {
    if (resources.has(required)) continue;
    findings.push({
      templatePath,
      rule: "required-resource-missing",
      detail: `Resources.${required} is required (= ADR-002 Phase 2.1: 全 problem template で参加者 federation 用 Role を宣言する)`,
    });
  }
  for (const required of REQUIRED_OUTPUT_KEYS) {
    if (outputs.has(required)) continue;
    findings.push({
      templatePath,
      rule: "required-output-missing",
      detail: `Outputs.${required} is required (= sso.ts handler が読む key)`,
    });
  }
  return findings;
}

function checkUnresolvedRefs(
  templatePath: string,
  refs: readonly string[],
  resources: Set<string>,
  parameters: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const ref of refs) {
    if (PSEUDO_PARAMETERS.has(ref)) continue;
    if (resources.has(ref) || parameters.has(ref)) continue;
    findings.push({
      templatePath,
      rule: "unresolved-ref",
      detail: `Ref: ${ref} — not declared in Resources / Parameters / pseudo`,
    });
  }
  return findings;
}

function checkUnresolvedGetAttResources(
  templatePath: string,
  getAttResources: readonly string[],
  resources: Set<string>,
  parameters: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
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

export type { Finding };
export { collectGetAttResources, collectRefs, collectSubRefs, parseSections };

export function checkTemplate(templatePath: string): Finding[] {
  const yaml = readFileSync(templatePath, "utf8");
  const { resources, parameters, outputs } = parseSections(yaml);
  const subRefs = collectSubRefs(yaml);
  return [
    ...checkRequiredDeclarations(templatePath, resources, outputs),
    ...checkUnresolvedRefs(
      templatePath,
      [...collectRefs(yaml), ...subRefs.refs],
      resources,
      parameters,
    ),
    ...checkUnresolvedGetAttResources(
      templatePath,
      [...collectGetAttResources(yaml), ...subRefs.getAtts],
      resources,
      parameters,
    ),
  ];
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

if (import.meta.main) main();
