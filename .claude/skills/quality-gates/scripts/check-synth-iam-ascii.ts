#!/usr/bin/env bun
/**
 * [Issue #664 follow-up] Scan the **synthesized** CloudFormation for IAM Role / ManagedPolicy
 * descriptions that contain a character outside the IAM Latin-1 range — the class of bug that
 * `CREATE_FAILED` a real deploy (`ChallengePayloadStack` PublishRole had a U+2192 `->` arrow).
 *
 * `scripts/check-template-ascii.ts` covers hand-written YAML; this covers descriptions set in CDK,
 * which only exist in the synth output (often wrapped in `Fn::Join`). Run AFTER `cdk synth` — the
 * `check-synth` make target invokes it on the freshly-written `cdk.out`.
 *
 *   bun run scripts/check-synth-iam-ascii.ts                 # scans infrastructure/cdk.out
 *   bun run scripts/check-synth-iam-ascii.ts <synth-outdir>  # explicit dir
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// Gate logic は scripts/lib/ の共有実装 (docs/shared-utils.md) が単一の正。
// infrastructure/test の synth assertion も同じ scanner を使う (= 判定ドリフト防止)。
import {
  formatCodePoint,
  type IamDescriptionFinding,
  scanTemplateForIamDescriptions,
} from "../../../../scripts/lib/iam-description-ascii";

const DEFAULT_OUTDIR = "infrastructure/cdk.out";

function templateFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`ERROR: synth outdir not found: ${dir} (run cdk synth first)`);
    process.exit(1);
  }
  return entries
    .filter((name) => name.endsWith(".template.json"))
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile());
}

const outdir = process.argv[2] ?? DEFAULT_OUTDIR;
const files = templateFiles(outdir);
if (files.length === 0) {
  console.error(`ERROR: no *.template.json under ${outdir} (run cdk synth first)`);
  process.exit(1);
}

const findings: Array<IamDescriptionFinding & { file: string }> = [];
for (const file of files) {
  let template: unknown;
  try {
    template = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`ERROR: ${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  for (const f of scanTemplateForIamDescriptions(template)) findings.push({ ...f, file });
}

if (findings.length > 0) {
  console.error(
    "NG: 合成後の CFn に IAM Description の非 Latin-1 文字があります (#664 / CREATE_FAILED 必至)",
  );
  for (const f of findings) {
    console.error(
      `  ${f.file}: ${f.logicalId} (${f.resourceType}) Description に ${formatCodePoint(f.codePoint)} (${f.char}) — fragment: ${JSON.stringify(f.fragment)}`,
    );
  }
  console.error(
    "\nIAM Role / ManagedPolicy の description は ASCII (0x20-0x7E) + Latin-1 (0xA1-0xFF) のみ。\n" +
      "CDK 側の `description:` から CJK / 矢印 (→) / em-dash 等を ASCII (例: -> ) に置換してください。",
  );
  process.exit(1);
}

console.log(
  `OK: ${files.length} synthesized template(s) の IAM Description はすべて Latin-1 範囲 (#664 safe)`,
);
