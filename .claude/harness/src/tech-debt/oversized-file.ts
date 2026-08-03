import type { Finding, Rule, RuleContext } from "../types.ts";
import { isProductionSource } from "./production-scope.ts";

/**
 * Issue #2527 Slice 7: oversized production files as trackable tech debt.
 *
 * Complements the architecture harness's `file-too-large` gate (warn >= 500 /
 * error >= 800 on STAGED files): this rule scans the whole tree on `make tech-debt`
 * at the epic's tighter guideline — the #2527 target for entrypoints and UI/CLI
 * modules is <= 400 lines — so growth toward the hard gate shows up in the backlog
 * while it is still cheap to split. Existing violations are frozen in
 * `tech-debt-oversized-file.json`; the ratchet only surfaces NEW oversized files
 * (or an existing file crossing into the error bucket).
 *
 * Thresholds (per the epic: "warning > 400 / error > 800"):
 *   - > 400 lines  -> warning
 *   - > 800 lines  -> error
 *
 * Scope mirrors `high-coupling` (production roots only). Test files, generated
 * output, dist, and cdk.out are excluded — reference/data modules regenerate or
 * grow mechanically and are not split candidates.
 *
 * `match` is the bucket (gt-400-lines / gt-800-lines) so +-1 line does not detach
 * a baseline entry; crossing 800 changes the bucket and resurfaces the file.
 */

const WARNING_THRESHOLD = 400;
const ERROR_THRESHOLD = 800;

// スコープ定義は high-coupling と共通 (production-scope.ts、 #2866)。
const shouldInspect = isProductionSource;

export function countLines(source: string): number {
  if (source === "") return 0;
  let count = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") count += 1;
  }
  // A trailing newline does not start a new (real) line.
  if (source.endsWith("\n")) count -= 1;
  return count;
}

export const oversizedFile: Rule = {
  id: "oversized-file",
  severity: "warning",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!shouldInspect(path)) continue;
      let content: string;
      try {
        content = ctx.readFile(path);
      } catch {
        continue;
      }
      const lines = countLines(content);
      if (lines <= WARNING_THRESHOLD) continue;
      const isError = lines > ERROR_THRESHOLD;
      findings.push({
        ruleId: "oversized-file",
        severity: isError ? "error" : "warning",
        filePath: path,
        line: 1,
        match: isError ? "gt-800-lines" : "gt-400-lines",
        message: `Production file is ${lines} lines (guideline: <= ${WARNING_THRESHOLD}). 1 ファイルの責務超過候補 (#2527)。`,
        recommendation:
          "変更理由ごとに module を分割する (#2527 の builder / hook+view / adapter-state-link 分割パターンを参照)。 " +
          "エントリポイントは composition + routing に限定し、 pure logic は sibling module へ移す。",
      });
    }
    return findings;
  },
};
