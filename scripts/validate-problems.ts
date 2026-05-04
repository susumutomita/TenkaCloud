#!/usr/bin/env bun
/**
 * problems/ 配下のすべての metadata.json を problems/SCHEMA.json で validate する。
 *
 * Usage:
 *   bun run scripts/validate-problems.ts
 *
 * 失敗時は exit code 1 + エラー内容を stderr に出す。CI / pre-commit で実行する想定。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
    if (validate(data)) {
      console.log(`OK  ${rel}`);
      continue;
    }
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
  }

  if (failed > 0) {
    console.error(
      `\n${failed} / ${metadataFiles.length} 件の metadata.json が schema に違反しています`,
    );
    process.exit(1);
  }
  console.log(`\n${metadataFiles.length} 件の metadata.json はすべて有効です`);
}

main();
