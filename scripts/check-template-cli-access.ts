#!/usr/bin/env bun
/**
 * 問題 template.yaml の `ParticipantViewerRole` が、 競技者が AWS Console から
 * シームレスに環境を触るために必要な AWS managed policy を attach しているか
 * 確認する。
 *
 * 必須 managed policy:
 *   - `AWSSignInLocalDevelopmentAccess` — Console federation セッションを CLI
 *      (`aws` コマンド) に持ち出すために必要。 これが無いと Console login は
 *      成功するが、 ターミナルに切り替えた瞬間に静かに reject される
 *   - `AWSCloudShellFullAccess` — Console 内 CloudShell の起動権限。 これが
 *      無いと CloudShell タブで 「環境を作成できません」 エラーになる。
 *      CloudShell は federated role 直下で動くため、 ここで attach すれば
 *      CloudShell 内のコマンドは ParticipantViewerRole として実行される
 *      (= 別途 sts:AssumeRole 不要)
 *
 * 背景: 競技者は AWS Console 画面では 「ログインできた」 と認識する一方で、
 * CLI / CloudShell に切り替えた瞬間に静かに失敗するため、 切り分けが難しい。
 * 問題作成側で template を書くたびに同じ落とし穴を踏むので、 platform 側で
 * 機械チェックして 「これを attach してください」 と即フィードバックする。
 *
 * 出典:
 *   https://docs.aws.amazon.com/signin/latest/userguide/security-iam-awsmanpol.html#security-iam-awsmanpol-SignInLocalDevelopmentAccess
 *   https://docs.aws.amazon.com/cloudshell/latest/userguide/sec-auth-with-identities.html
 *
 * 検出ルール:
 *   - 全 problem template に対して `^  ParticipantViewerRole:` から次の
 *     top-level Resource 宣言までを 1 block として切り出す
 *   - block 内に literal ARN suffix
 *     `:policy/AWSSignInLocalDevelopmentAccess` および
 *     `:policy/AWSCloudShellFullAccess` の両方を含まなければ NG
 *   - `!Sub "arn:...AWSCloudShellFullAccess"` 等の変則表記も
 *     文字列レベルで拾えるよう、 suffix で許容する
 *
 * `make validate-problems` の後段で呼ぶ。 fail-fast (exit 1) で問題作成者の
 * 早い段階で気付かせる。
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBLEMS_DIR = join(REPO_ROOT, "problems");

interface RequiredPolicy {
  readonly arnSuffix: string;
  readonly purpose: string;
  readonly docUrl: string;
}

const REQUIRED_POLICIES: readonly RequiredPolicy[] = [
  {
    arnSuffix: ":policy/AWSSignInLocalDevelopmentAccess",
    purpose: "Console federation 後の CLI (`aws` コマンド) access",
    docUrl:
      "https://docs.aws.amazon.com/signin/latest/userguide/security-iam-awsmanpol.html#security-iam-awsmanpol-SignInLocalDevelopmentAccess",
  },
  {
    arnSuffix: ":policy/AWSCloudShellFullAccess",
    purpose: "Console 内 CloudShell 起動 + 内部での AWS API 操作",
    docUrl: "https://docs.aws.amazon.com/cloudshell/latest/userguide/sec-auth-with-identities.html",
  },
];

interface Finding {
  readonly templatePath: string;
  readonly missing: readonly RequiredPolicy[];
}

/**
 * `^  ParticipantViewerRole:` の block を切り出す。 block 終端は
 * 次の同インデント (2 spaces) の resource 宣言、 もしくは次の top-level section。
 *
 * YAML loader を使わないのは check-template-cfn-refs.ts と整合させるため
 * (= ! tag を含む CFn 拡張形を loader 非依存で扱う)。
 */
export function extractParticipantViewerBlock(yaml: string): string | undefined {
  const lines = yaml.split("\n");
  let start: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "  ParticipantViewerRole:") {
      start = i;
      break;
    }
  }
  if (start === undefined) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // 次の Resource (= 2-space indent + Name:) または top-level section に当たったら終端
    if (/^ {2}[A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) {
      end = i;
      break;
    }
    if (/^[A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function findMissingRequiredPolicies(block: string): readonly RequiredPolicy[] {
  return REQUIRED_POLICIES.filter((p) => !block.includes(p.arnSuffix));
}

export function checkTemplate(templatePath: string): Finding[] {
  const yaml = readFileSync(templatePath, "utf8");
  const block = extractParticipantViewerBlock(yaml);
  if (block === undefined) {
    // check-template-cfn-refs が ParticipantViewerRole 必須宣言を別途検証している
    // ので、 ここで二重検出はしない (= 該当 role が無いテンプレートは skip)。
    return [];
  }
  const missing = findMissingRequiredPolicies(block);
  if (missing.length === 0) return [];
  return [{ templatePath, missing }];
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
      `OK: ${templates.length} template(s) スキャン、` +
        " ParticipantViewerRole は CLI / CloudShell access に必要な managed policy を全て attach 済",
    );
    return;
  }
  for (const f of allFindings) {
    const rel = relative(REPO_ROOT, f.templatePath);
    for (const m of f.missing) {
      console.error(`NG ${rel}: ${m.arnSuffix.slice(1)} 未 attach (= ${m.purpose})`);
    }
  }
  console.error("");
  console.error("修正方法: ParticipantViewerRole の Properties に以下を追加してください:");
  console.error("");
  console.error("  Properties:");
  console.error("    ManagedPolicyArns:");
  for (const p of REQUIRED_POLICIES) {
    console.error(`      - arn:aws:iam::aws:policy${p.arnSuffix.slice(":policy".length)}`);
  }
  console.error("");
  console.error("参考:");
  for (const p of REQUIRED_POLICIES) {
    console.error(`  - ${p.docUrl}`);
  }
  process.exit(1);
}

if (import.meta.main) main();
