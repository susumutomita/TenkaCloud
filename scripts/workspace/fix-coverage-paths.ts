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

const WORKSPACES = [
  "infrastructure",
  "apps/admin-console",
  "apps/application-admin-console",
  "apps/participant-portal",
  "packages/trust-bridge",
] as const;

let fixed = 0;
let skipped = 0;
for (const ws of WORKSPACES) {
  const path = resolve(process.cwd(), ws, "coverage/lcov.info");
  if (!existsSync(path)) {
    console.log(`  skip: ${ws}/coverage/lcov.info (not found)`);
    skipped++;
    continue;
  }
  const content = readFileSync(path, "utf8");
  // SF: が既に "apps/" / "infrastructure/" / "packages/" で始まっている場合は skip
  // (= 二重 prefix 防止、 idempotent)
  if (/^SF:(apps|infrastructure|packages)\//m.test(content)) {
    console.log(`  skip: ${ws}/coverage/lcov.info (already prefixed)`);
    skipped++;
    continue;
  }
  const updated = content.replace(/^SF:/gm, `SF:${ws}/`);
  writeFileSync(path, updated, "utf8");
  console.log(`  fix:  ${ws}/coverage/lcov.info`);
  fixed++;
}

console.log(`fix-coverage-paths: ${fixed} fixed, ${skipped} skipped`);
