#!/usr/bin/env bun
/**
 * HTTP status code の magic number 直書き禁止チェック (CLAUDE.md コーディング規約)。
 *
 * 検査対象パターン (= 違反):
 *   - backend (Hono): `c.json(body, 200)` のように literal HTTP status を渡す
 *   - frontend (fetch): `res.status === 401` / `err.status === 409` の literal 比較
 *
 * `StatusCodes.OK` / `HTTP_OK` (legacy alias) のような **named constant** はパス。
 * 探索対象は infrastructure/lib および apps の各 src 配下の .ts / .tsx (= test / dist / node_modules 除外)。
 *
 * exit code: 違反 0 件で 0、1 件以上で 1 + 違反一覧を stderr に列挙。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "infrastructure/lib",
  "apps/admin-console/src",
  "apps/application-admin-console/src",
  "apps/participant-portal/src",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "cdk.out", ".next", "build"]);

/** ファイル内に違反 line があれば `{file, line, text, reason}` を yield */
function* findViolations(
  absPath: string,
  rel: string,
): Generator<{
  file: string;
  line: number;
  text: string;
  reason: string;
}> {
  const src = readFileSync(absPath, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // skip コメント / 文字列内の literal は厳密判定が難しいので簡易: trim 先頭が // / * なら skip
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    // 1. `c.json(..., NNN)` literal status
    if (/c\.json\s*\([^)]*,\s*[0-9]{3}\b/.test(line)) {
      yield {
        file: rel,
        line: i + 1,
        text: line.trim(),
        reason: "c.json(body, <number>) — StatusCodes.* を使う",
      };
    }
    // 2. `.status === NNN` literal comparison (200-599)
    const cmpMatch = line.match(/\.status\s*[!=]==?\s*([0-9]{3})\b/);
    if (cmpMatch?.[1]) {
      const n = Number(cmpMatch[1]);
      if (n >= 200 && n < 600) {
        yield {
          file: rel,
          line: i + 1,
          text: line.trim(),
          reason: ".status === <number> — StatusCodes.* を使う",
        };
      }
    }
  }
}

function* walk(root: string, base = root): Generator<{ abs: string; rel: string }> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(root, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walk(abs, base);
    } else if (st.isFile() && /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield { abs, rel: abs };
    }
  }
}

const violations: ReturnType<typeof findViolations> extends Generator<infer V> ? V[] : never = [];

for (const root of ROOTS) {
  for (const { abs, rel } of walk(root)) {
    // `infrastructure/lib/problem-deploy/handlers/shared/http-status.ts` 自体は library と HTTP_*
    // alias を定義する場所 (= literal が許される唯一の例外)。ただし当 file は library 経由なので
    // literal は無い想定。defensive に skip。
    if (rel.endsWith("shared/http-status.ts")) continue;
    for (const v of findViolations(abs, rel)) {
      violations.push(v);
    }
  }
}

if (violations.length === 0) {
  console.log("OK: HTTP status code の magic number 直書きはありません");
  process.exit(0);
}

console.error(`✗ HTTP status code の magic number 直書きを ${violations.length} 件検出:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    → ${v.reason}`);
  console.error("");
}
console.error("修正例:");
console.error("  ✗ return c.json(body, 200);");
console.error('  ✓ import { StatusCodes } from "http-status-codes";');
console.error("  ✓ return c.json(body, StatusCodes.OK);");
console.error("");
console.error("詳細: CLAUDE.md / AGENTS.md の「HTTP status code は magic number 禁止」 section");

process.exit(1);
