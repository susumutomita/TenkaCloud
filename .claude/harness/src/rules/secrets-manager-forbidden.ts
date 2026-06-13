import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * cost-zero principle (CLAUDE.md): AWS Secrets Manager は per-secret 課金が発生するため
 * 使用禁止。秘匿値は SSM Parameter Store SecureString (standard tier = 無料) に置く。
 *
 * CLAUDE.md / harness.md は本ルールを機械チェック対象として記載していたが、実装が
 * 存在しなかった (= 偽りの安全保証)。ドキュメントの契約に実装を合わせる。
 *
 * Scope: リポジトリ内のすべての .ts (infrastructure / apps / scripts / packages)。
 * `@aws-sdk/client-secrets-manager` の import と、CDK の `aws-cdk-lib/aws-secretsmanager`
 * construct import の両方を error にする。
 */

// `import ... from "x"` / side-effect `import "x"` / dynamic `import("x")` / `require("x")`
// のすべての取り込み形式を捕まえる (= `from` 限定だと side-effect import がすり抜ける)。
const SECRETS_MANAGER_IMPORT_RE =
  /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["'](@aws-sdk\/client-secrets-manager|aws-cdk-lib\/aws-secretsmanager)["']/;

function shouldInspect(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.includes("node_modules/")) return false;
  // harness 自身 (本ルールの定義 / テスト) は対象外。
  if (path.startsWith(".claude/harness/")) return false;
  return true;
}

export const secretsManagerForbidden: Rule = {
  id: "secrets-manager-forbidden",
  severity: "error",
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
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const m = line.match(SECRETS_MANAGER_IMPORT_RE);
        if (!m) continue;
        findings.push({
          ruleId: "secrets-manager-forbidden",
          severity: "error",
          filePath: path,
          line: i + 1,
          match: m[1] ?? "secrets-manager",
          message:
            "AWS Secrets Manager is forbidden (per-secret cost). Import of " +
            (m[1] ?? "secrets-manager") +
            " detected.",
          recommendation:
            "Store the secret in SSM Parameter Store as a SecureString (standard tier is free). " +
            "See CLAUDE.md cost-zero principle.",
        });
      }
    }
    return findings;
  },
};
