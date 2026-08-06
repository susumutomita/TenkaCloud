import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DEFINE_VALUE_BYTES } from "../../lib/utils/define-nodejs-function";
import { readCatalogBlob } from "../../lib/utils/read-catalog-blob";

/**
 * #2891: カタログ blob の運び方は env (4KB 上限) → gzip env (再超過) → esbuild define
 * (argv 128KiB 上限で E2BIG) と、 固定の天井に 3 回ぶつかった。 4 代目の bundle 同梱
 * ファイルには天井が無い。 ここで pin するのは読み順と、 天井に近づいた define を
 * 名前入りで落とすガード。
 */

const NAME = "BATTLE_PROBLEMS_TEST_BLOB";
const cleanup: string[] = [];

afterEach(() => {
  delete process.env[NAME];
  delete process.env.LAMBDA_TASK_ROOT;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readCatalogBlob", () => {
  it("prefers the env value, which is how tests and small defines inject", () => {
    process.env[NAME] = '{"from":"env"}';
    expect(readCatalogBlob(NAME)).toBe('{"from":"env"}');
  });

  it("falls back to the bundled file under LAMBDA_TASK_ROOT", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-blob-"));
    cleanup.push(root);
    mkdirSync(join(root, "catalog-data"));
    writeFileSync(join(root, "catalog-data", `${NAME}.json`), '{"from":"file"}');
    process.env.LAMBDA_TASK_ROOT = root;
    expect(readCatalogBlob(NAME)).toBe('{"from":"file"}');
  });

  it("returns undefined when neither exists, so callers keep their own fallback", () => {
    expect(readCatalogBlob(NAME)).toBeUndefined();
    process.env.LAMBDA_TASK_ROOT = mkdtempSync(join(tmpdir(), "tc-blob-empty-"));
    cleanup.push(process.env.LAMBDA_TASK_ROOT);
    expect(readCatalogBlob(NAME)).toBeUndefined();
  });
});

describe("the define-size guard", () => {
  it("keeps the ceiling below the Linux single-argument limit", () => {
    // 128 KiB が OS の壁。 手前で名前入りで落とすことに意味がある — E2BIG は
    // どの define が犯人かを言わない。
    expect(MAX_DEFINE_VALUE_BYTES).toBeLessThan(128 * 1024);
  });
});
