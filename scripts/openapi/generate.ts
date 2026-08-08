#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildMachineApiSpec, findSecretMaterial, serializeSpec } from "./machine-api-spec.ts";

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

/**
 * 生成物は `make lint` (biome) の検査対象でもあるので、生成側で biome の整形を通しておく。
 * これをやらないと「生成器の JSON.stringify」と「biome の formatter」が別々の正解を持ち、
 * `make openapi-check` と `make lint` が互いを壊し合う状態になる。
 *
 * 整形は空白しか変えないが、配列を 1 行へ畳む過程で token が隣接しうるので、
 * credential 検査は **整形後の文字列に対しても**もう一度かける。
 */
function formatWithBiome(source: string): string {
  // PATH 探索ではなく workspace 内の絶対パスで起動する。生成器は CI でも走るので、
  // どの `biome` が起動するかを PATH に委ねない (sonarjs/no-os-command-from-path)。
  const biome = resolve(repoRoot(), "node_modules/.bin/biome");
  const formatted = execFileSync(biome, ["format", `--stdin-file-path=${SPEC_RELATIVE_PATH}`], {
    cwd: repoRoot(),
    input: source,
    encoding: "utf8",
  });
  const leaks = findSecretMaterial(formatted);
  if (leaks.length > 0) {
    throw new Error(
      `整形後の OpenAPI spec に credential material が含まれています: ${leaks.join(", ")}`,
    );
  }
  return formatted;
}

/**
 * commit 済み生成物と 1 byte 単位で比較できる、この file の唯一の正解。書き出しも `--check`
 * も test もこれを通す。test が `serializeSpec` を直接呼ぶと整形段を素通りしてしまい、
 * 「test は緑なのに `make lint` が落ちる」状態が作れてしまうため、入口を 1 つに寄せてある。
 */
export function renderSpecFile(): string {
  return formatWithBiome(serializeSpec(buildMachineApiSpec()));
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const target = resolve(repoRoot(), SPEC_RELATIVE_PATH);
  const serialized = renderSpecFile();

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
