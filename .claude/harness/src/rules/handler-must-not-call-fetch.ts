import { scanLinesByRegex } from "../scan-lines.ts";
import type { Rule } from "../types.ts";

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

function shouldInspect(path: string): boolean {
  if (!path.startsWith("infrastructure/lib/")) return false;
  if (!path.includes("/handlers/")) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  return true;
}

export const handlerMustNotCallFetch: Rule = {
  id: "handler-must-not-call-fetch",
  severity: "error",
  check(ctx) {
    // `stripComments` reproduces the block/line-comment state machine this rule
    // carried inline: a `fetch(` inside a `/* ... */` block or a `//` comment is
    // not a violation (= the false positive this rule was written to avoid).
    return scanLinesByRegex(ctx, {
      ruleId: "handler-must-not-call-fetch",
      severity: "error",
      shouldInspect,
      lineRegex: FETCH_CALL_RE,
      stripComments: true,
      buildFinding: () => ({
        match: "fetch(",
        message:
          "Handler code is calling fetch() directly. HTTP I/O belongs in an injectable " +
          "client module (Service / Repository layer), not in lib/handlers/.",
        recommendation:
          "Extract the HTTP call into a dedicated client (see infrastructure/lib/problem-deploy/" +
          "runtime-clients/ for the established pattern) and inject it, so handlers stay " +
          "mockable and timeout/retry policy stays centralized.",
      }),
    });
  },
};
