#!/usr/bin/env bun
/**
 * problems/ 配下のすべての metadata.json を problems/SCHEMA.json で validate する。
 * 加えて #951 sub #2 で template.yaml との cross-ref も検査 (= 実 deploy 前に
 * scoring engine が読めない / endpoints が解決できない / portal slot が存在しない
 * パターンを検出する)。
 *
 * Usage:
 *   bun run scripts/validate-problems.ts
 *
 * 失敗時は exit code 1 + エラー内容を stderr に出す。CI / pre-commit で実行する想定。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import Ajv2020 from "ajv";
import addFormats from "ajv-formats";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROBLEMS_DIR = join(REPO_ROOT, "problems");
const SCHEMA_PATH = join(PROBLEMS_DIR, "SCHEMA.json");

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
    if (isDir) {
      found.push(...findMetadataFiles(full));
    } else if (entry === "metadata.json") {
      found.push(full);
    }
  }
  return found;
}

/**
 * metadata.json と template.yaml の間の cross-ref を検査する。
 *   - flag kind: scoring.flagOutputKey が template.yaml Outputs に存在
 *   - attack-detection kind: scoring.statsOutputKey が Outputs に存在
 *   - endpoints[].default.key (= cfn-output binding) が Outputs に存在
 *   - dashboard.slots["<slot>"] の portal/<file>.tsx が物理 file として存在
 *
 * 実 deploy で CFn が CREATE_COMPLETE しても、 これらの参照が解決できないと
 * scoring engine / portal が壊れるので、 ここで先に止める。
 */
function checkCrossRefs(metaPath: string, meta: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const dir = dirname(metaPath);
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
  const templatePath = join(dir, cfnTemplate);

  if (!existsSync(templatePath)) {
    errors.push(`cfnTemplate file "${cfnTemplate}" not found`);
    return errors;
  }
  const yaml = readFileSync(templatePath, "utf8");

  const scoring = meta.scoring as Record<string, unknown> | undefined;
  const kind = scoring?.kind;

  // flag kind: flagOutputKey が Outputs に存在するか
  if (kind === "flag") {
    const flagKey = scoring?.flagOutputKey;
    if (typeof flagKey === "string" && !yaml.includes(`${flagKey}:`)) {
      errors.push(
        `scoring.flagOutputKey="${flagKey}" not found in ${cfnTemplate} Outputs (= scoring engine が読めない)`,
      );
    }
  }

  // attack-detection: statsOutputKey が Outputs に存在するか
  if (kind === "attack-detection") {
    const statsKey = scoring?.statsOutputKey;
    if (typeof statsKey === "string" && !yaml.includes(`${statsKey}:`)) {
      errors.push(`scoring.statsOutputKey="${statsKey}" not found in ${cfnTemplate} Outputs`);
    }
  }

  // endpoints[].default.key (= cfn-output binding) が Outputs に存在するか
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  for (const ep of endpoints as Array<Record<string, unknown>>) {
    const def = ep.default as Record<string, unknown> | undefined;
    const from = def?.from;
    const key = def?.key;
    if (from === "cfn-output" && typeof key === "string" && !yaml.includes(`${key}:`)) {
      errors.push(
        `endpoints[slot=${String(ep.slot)}].default.key="${key}" not found in ${cfnTemplate} Outputs`,
      );
    }
  }

  // dashboard.slots["<slot>"] の portal/<file>.tsx が物理 file として存在するか
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (slots) {
    for (const [slotName, slotPath] of Object.entries(slots)) {
      if (typeof slotPath === "string") {
        const physical = join(dir, slotPath);
        if (!existsSync(physical)) {
          errors.push(`dashboard.slots["${slotName}"]="${slotPath}" file not found`);
        }
      }
    }
  }

  return errors;
}

function main(): void {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const metadataFiles = findMetadataFiles(PROBLEMS_DIR);
  if (metadataFiles.length === 0) {
    console.error("No metadata.json found under problems/. At least one problem is expected.");
    process.exit(1);
  }

  let failed = 0;
  for (const file of metadataFiles) {
    const rel = relative(REPO_ROOT, file);
    const data = JSON.parse(readFileSync(file, "utf8"));

    let schemaOk = validate(data);
    if (!schemaOk) {
      failed += 1;
      console.error(`NG  ${rel}`);
      for (const err of validate.errors ?? []) {
        console.error(`     ${err.instancePath || "(root)"} ${err.message ?? ""}`);
      }
      // id とディレクトリ名の一致もチェック (schema では強制できないので別途)
      const expectedId = file.split("/").slice(-2, -1)[0];
      if (data.id && data.id !== expectedId) {
        console.error(`     id (${data.id}) はディレクトリ名 (${expectedId}) と一致させてください`);
      }
      continue;
    }

    // SCHEMA OK でも cross-ref が壊れていれば NG にする
    const crossRefErrors = checkCrossRefs(file, data);
    if (crossRefErrors.length > 0) {
      schemaOk = false;
      failed += 1;
      console.error(`NG  ${rel} (cross-ref)`);
      for (const e of crossRefErrors) {
        console.error(`     ${e}`);
      }
      continue;
    }

    console.log(`OK  ${rel}`);
  }

  if (failed > 0) {
    console.error(
      `\n${failed} / ${metadataFiles.length} 件の metadata.json が schema / cross-ref に違反しています`,
    );
    process.exit(1);
  }
  console.log(`\n${metadataFiles.length} 件の metadata.json はすべて有効です`);
}

main();
