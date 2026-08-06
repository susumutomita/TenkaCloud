import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * カタログ由来の大きな JSON blob を Lambda runtime で読む (#2891)。
 *
 * この値の運び方は 3 代目になる。 env (4 KB 上限, #810) → gzip+base64 env (再超過,
 * #1158) → esbuild define (= argv。 Linux の 1 引数上限 128 KiB を educationGraph
 * 309 KiB が超えて E2BIG, #2891)。 どれも「固定の天井にカタログの成長をぶつける」
 * 形で、 天井を一段高くするたびに同じ壊れ方が再演された。 bundle 内のファイルには
 * 実用上の天井が無いので、 ここで打ち止めにする。
 *
 * 圧縮して define に留まる方向は採らない — 天井が 4 代目に繰り越されるだけ。
 *
 * 読み順:
 *   1. `process.env[name]` — 小さい blob は従来どおり esbuild define が literal 置換
 *      する。 テストも env に fixture を刺す (= 動的 lookup なので define 無しでも効く)。
 *   2. bundle 同梱の `catalog-data/<name>.json` — synth 時に defineNodejsFunction の
 *      `bundledData` が置いたもの。 `LAMBDA_TASK_ROOT` は Lambda runtime が必ず設定する
 *      ので、 これが bundle の場所を指す。 __dirname を使わないのは、 このファイルが
 *      cjs bundle (Lambda) と ESM の test runner の両方から import されるため。
 */
export function readCatalogBlob(name: string): string | undefined {
  const inline = process.env[name];
  if (inline !== undefined) return inline;
  const taskRoot = process.env.LAMBDA_TASK_ROOT;
  if (!taskRoot) return undefined;
  try {
    return readFileSync(join(taskRoot, "catalog-data", `${name}.json`), "utf8");
  } catch {
    return undefined;
  }
}
