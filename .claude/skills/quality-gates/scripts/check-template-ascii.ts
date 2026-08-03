#!/usr/bin/env bun
/**
 * IAM Role / Policy / IAM-adjacent CFn Resource の Description field は
 * IAM service が regex [tab/LF/CR + 0x20-0x7E + 0xA1-0xFF]* を強制する。
 * CJK 文字 (= 日本語 / 中文等の BMP 上位面) を含むと CREATE_FAILED で stack
 * 作成自体が落ちる (= Issue #664)。
 *
 * infrastructure/templates/ 配下は競技者が自分の AWS account で deploy する
 * 唯一の経路なので、 CJK が紛れ込むと competitor onboarding が全断する。
 * 本 checker は templates yaml を ASCII + Latin-1 範囲で gate して、
 * #664 系 regression を merge 前に検出する。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
// Gate logic は scripts/lib/ の共有実装 (docs/shared-utils.md) が単一の正。
// infrastructure/test の synth assertion も同じ scanner を使う (= 判定ドリフト防止)。
import { isAllowedCharCode } from "../../../../scripts/lib/iam-description-ascii";

/**
 * プラットフォームが gate するのは自前の infrastructure/templates/ のみ。
 * 問題テンプレート (problems/<category>/<id>/template.yaml) は別リポ
 * TenkaCloudChallenge (problems/ submodule) が正本で、 ASCII / IAM Description
 * 検証もカタログ側 (problems/scripts/) が持つ。 プラットフォームは問題を host する
 * だけで、 プラグインである問題テンプレの検証責務は負わない (= problems/** は除外)。
 */
const TEMPLATES_DIRS = ["infrastructure/templates"];

function isCfnTemplate(filename: string): boolean {
  // CFn template は `*.yaml` のみ (= ASCII restriction が IAM Description 経由で効く)。
  // docker-compose.yml 等の `.yml` infra-adjacent ファイルは CFn 経由で deploy されないので対象外。
  return extname(filename) === ".yaml";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (isCfnTemplate(entry)) {
      out.push(full);
    }
  }
  return out;
}

const errors: string[] = [];
const allFiles = TEMPLATES_DIRS.flatMap(walk);
for (const file of allFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, idx) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (!isAllowedCharCode(cp)) {
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");
        errors.push(
          `${file}:${idx + 1}: contains non-Latin1 char U+${hex} (${ch}) — IAM Description で CREATE_FAILED の原因になる`,
        );
        break;
      }
    }
  });
}

if (errors.length > 0) {
  console.error("NG: CFn テンプレに CJK / 非 Latin-1 文字が含まれています (#664)");
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    "\nIAM Role / Policy Description は ASCII (0x20-0x7E) + Latin-1 supplement (0xA1-0xFF)\n" +
      "のみ許容します。 CJK / 日本語を ASCII の英語に置換してください。",
  );
  process.exit(1);
}

console.log(
  `OK: ${TEMPLATES_DIRS.join(" + ")} 配下 ${allFiles.length} yaml すべて ASCII + Latin-1 範囲 (IAM Description 安全)`,
);
