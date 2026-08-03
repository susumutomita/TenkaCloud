import type { Finding, Rule, RuleContext } from "../types.ts";
import { isProductionSource } from "./production-scope.ts";

/**
 * Issue #1227: high-coupling detector.
 *
 * 1 ファイルが 16 個以上の module を `import` していると 「責務を持ちすぎ」 候補。 SRP 違反
 * の早期警告で、 file 行数の `file-too-large` と相補。
 *
 * 検出条件:
 *   - file top 付近の static `import ... from "..."` 文 (= side-effect import 含む) を数える
 *   - `import type` も coupling の cognitive load に寄与するので算入
 *   - 動的 import (`import(...)`) は除外
 *   - **16 個以上** で warning
 *
 * 対象 path: file-too-large 同様 `infrastructure/lib/`、 `apps/<spa>/src/`、 `scripts/`、
 * `packages/<pkg>/src/`。 test ファイル (`*.test.ts(x)`) は対象外 (= テストは複数 module を
 * 集約することが正当)。 generated / dist / cdk.out も除外。
 *
 * match は bucket (= 16-25 / 26-40 / 40+) にして 1 import 増減で baseline match を外さない。
 */

const WARNING_THRESHOLD = 16;
const HIGH_THRESHOLD = 26;
const VERY_HIGH_THRESHOLD = 41;

// スコープ定義は oversized-file と共通 (production-scope.ts、 #2866)。
const shouldInspect = isProductionSource;

// 行頭が `import` で始まるスタティック import 文を数える。 文字列内 / コメント内の "import"
// を誤検出しないため、 行頭 + ホワイトスペース後 + キーワード `import` のみカウントする。
// `import(...)` (= dynamic) は除外。
const STATIC_IMPORT_LINE_RE = /^\s*import(?:\s+type)?\s+(?:[^()]*?\bfrom\s+)?["'][^"']+["']/;

export function countTopLevelImports(source: string): number {
  // Cap to first 400 lines to avoid scanning whole long file; imports always at top.
  const lines = source.split("\n").slice(0, 400);
  let count = 0;
  for (const line of lines) {
    if (STATIC_IMPORT_LINE_RE.test(line)) count += 1;
  }
  return count;
}

function bucket(count: number): string {
  if (count >= VERY_HIGH_THRESHOLD) return "ge-41-imports";
  if (count >= HIGH_THRESHOLD) return "ge-26-imports";
  return "ge-16-imports";
}

export const highCoupling: Rule = {
  id: "high-coupling",
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
      const count = countTopLevelImports(content);
      if (count < WARNING_THRESHOLD) continue;
      const severity = count >= VERY_HIGH_THRESHOLD ? "error" : "warning";
      findings.push({
        ruleId: "high-coupling",
        severity,
        filePath: path,
        line: 1,
        match: bucket(count),
        message:
          `${path} は ${count} 個の module を import している (閾値 ${WARNING_THRESHOLD})。 ` +
          "1 ファイルが多くの依存を直接抱えており、 責務超過 / 変更影響範囲が広い (= 高結合)。",
        recommendation:
          "関心領域ごとに sub-module を切り、 facade / index に集約する。 例: Lambda handler を " +
          "routes / service / repository に 3 層分割し、 index は routes と DI 配線のみに絞る。 " +
          "React page は presentational / container を分け、 各 panel を独立 component に export する。 " +
          "数値が 26+ の場合は責務分割を優先、 41+ は error (= 必ず分割)。",
      });
    }
    return findings;
  },
};

export const __INTERNAL = { WARNING_THRESHOLD, HIGH_THRESHOLD, VERY_HIGH_THRESHOLD };
