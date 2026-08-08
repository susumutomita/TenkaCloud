#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildMachineApiSpec, serializeSpec } from "./machine-api-spec.ts";

/**
 * Issue #2949: OpenAPI spec を生成して commit 済み生成物と突き合わせる。
 *
 *   bun run scripts/openapi/generate.ts           生成物を書き出す
 *   bun run scripts/openapi/generate.ts --check   差分があれば非ゼロ終了 (CI 用の drift 検査)
 *
 * `--check` は「生成物が source of truth と一致しているか」だけを見る。route を足したのに
 * 生成物を更新し忘れた PR はここで落ちる。
 */

export const SPEC_RELATIVE_PATH = "docs/api/machine-api.openapi.json";

function repoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../..");
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const target = resolve(repoRoot(), SPEC_RELATIVE_PATH);
  const serialized = serializeSpec(buildMachineApiSpec());

  if (check) {
    let current: string;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      console.error(
        `${SPEC_RELATIVE_PATH} がありません。 \`make openapi\` を実行して commit してください。`,
      );
      return 1;
    }
    if (current !== serialized) {
      console.error(
        `${SPEC_RELATIVE_PATH} が source of truth と一致しません。 \`make openapi\` を実行して commit してください。`,
      );
      return 1;
    }
    console.log(`OK: ${SPEC_RELATIVE_PATH} は source of truth と一致しています。`);
    return 0;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialized, "utf8");
  console.log(`wrote ${SPEC_RELATIVE_PATH}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
