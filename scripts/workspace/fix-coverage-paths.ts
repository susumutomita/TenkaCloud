#!/usr/bin/env bun
/**
 * Issue #993: Codecov 上の coverage が空になる問題への post-process。
 *
 * vitest --coverage が生成する `apps/<x>/coverage/lcov.info` の SF: 行は
 * **workspace-root 相対** (= `SF:src/foo.ts`) で書かれる。 Codecov はこの SF を
 * repo root から見ようとして file が見つからず、 全行 0% 計算になっていた。
 *
 * 本 script は各 workspace の lcov.info を読み、 `SF:` 行を workspace dir で prefix する。
 * 例: `apps/admin-console/coverage/lcov.info` の `SF:src/api/foo.ts`
 *   → `SF:apps/admin-console/src/api/foo.ts`
 *
 * 同様の処理は本来 vitest config の `coverage.processFile` などで吸収できるが、
 * CLAUDE.md の 「設定ファイル直接変更禁止」 と整合させるため CLI 後段で処理する。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { COVERAGE_WORKSPACES } from "./run-coverage.ts";

/** Vitest emits workspace-relative SF paths; Codecov reads them from the repository root. */
export function prefixCoveragePaths(content: string, workspace: string): string {
  return content.replace(/^SF:(.+)$/gm, (record, source: string) => {
    if (/^(?:apps|infrastructure|packages)\//u.test(source) || source.startsWith("/"))
      return record;
    return `SF:${workspace}/${source}`;
  });
}

function main(): void {
  let fixed = 0;
  let skipped = 0;
  for (const { dir } of COVERAGE_WORKSPACES) {
    const path = resolve(process.cwd(), dir, "coverage/lcov.info");
    if (!existsSync(path)) {
      console.log(`  skip: ${dir}/coverage/lcov.info (not found)`);
      skipped++;
      continue;
    }
    const content = readFileSync(path, "utf8");
    const updated = prefixCoveragePaths(content, dir);
    if (updated === content) {
      console.log(`  skip: ${dir}/coverage/lcov.info (already prefixed)`);
      skipped++;
      continue;
    }
    writeFileSync(path, updated, "utf8");
    console.log(`  fix:  ${dir}/coverage/lcov.info`);
    fixed++;
  }
  console.log(`fix-coverage-paths: ${fixed} fixed, ${skipped} skipped`);
}

if (import.meta.main) main();
