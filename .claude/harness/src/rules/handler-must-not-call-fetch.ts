import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * CLAUDE.md / harness.md: `lib/handlers/` は `fetch(` を直接呼ばない (= HTTP I/O は
 * Service / Repository 層、実 REST client は `runtime-clients/` 等の専用 module に置く)。
 *
 * Rationale: handler 内の生 fetch は (1) テストで実 HTTP を mock する羽目になる、
 * (2) timeout / retry / エラー整形の方針が呼び出し箇所ごとに発散する、(3) endpoint が
 * handler に散らばり監査できない。runtime-clients (sakura/azure/gcp REST client) の
 * ような注入可能な client interface に閉じ込める。
 *
 * CLAUDE.md / harness.md は本ルールを機械チェック対象として記載していたが、実装が
 * 存在しなかった (= 偽りの安全保証)。ドキュメントの契約に実装を合わせる。
 * 既存違反は baseline (.claude/harness/baselines/handler-must-not-call-fetch.json) で
 * 許容し、新規追加のみ block する (= ratchet)。
 *
 * Scope: infrastructure/lib/**\/handlers/**\/*.ts (テストは除外)。
 */

const FETCH_CALL_RE = /\bfetch\s*\(/;
const LINE_COMMENT_RE = /^\s*(\/\/|\*|\/\*)/;
const BLOCK_COMMENT_OPEN_RE = /\/\*/;
const BLOCK_COMMENT_CLOSE_RE = /\*\//;

function shouldInspect(path: string): boolean {
  if (!path.startsWith("infrastructure/lib/")) return false;
  if (!path.includes("/handlers/")) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  return true;
}

function scanFile(path: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");
  // `/* ... */` の内側 (継続行が `*` で始まらない自由記述スタイルを含む) を除外する簡易
  // state machine。文字列リテラル内の `/*` までは追わない (= レビュー指摘の false positive
  // 解消が目的で、完全な TS パースは過剰)。
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (inBlockComment) {
      if (BLOCK_COMMENT_CLOSE_RE.test(line)) inBlockComment = false;
      continue;
    }
    if (BLOCK_COMMENT_OPEN_RE.test(line) && !BLOCK_COMMENT_CLOSE_RE.test(line)) {
      inBlockComment = true;
    }
    if (LINE_COMMENT_RE.test(line)) continue;
    if (!FETCH_CALL_RE.test(line)) continue;
    findings.push({
      ruleId: "handler-must-not-call-fetch",
      severity: "error",
      filePath: path,
      line: i + 1,
      match: "fetch(",
      message:
        "Handler code is calling fetch() directly. HTTP I/O belongs in an injectable " +
        "client module (Service / Repository layer), not in lib/handlers/.",
      recommendation:
        "Extract the HTTP call into a dedicated client (see infrastructure/lib/problem-deploy/" +
        "runtime-clients/ for the established pattern) and inject it, so handlers stay " +
        "mockable and timeout/retry policy stays centralized.",
    });
  }
  return findings;
}

export const handlerMustNotCallFetch: Rule = {
  id: "handler-must-not-call-fetch",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!shouldInspect(path)) continue;
      try {
        findings.push(...scanFile(path, ctx.readFile(path)));
      } catch {
        // 読めないファイル (削除 / バイナリ) は skip。
      }
    }
    return findings;
  },
};
