import { scanLinesByRegex } from "../scan-lines.ts";
import type { Rule } from "../types.ts";

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
  check(ctx) {
    // NOTE: `stripComments` is intentionally left off here — this rule historically
    // did NOT skip comment lines, so a commented-out import is (currently) still a
    // hit. Aligning it with `handler-must-not-call-fetch`'s comment-stripping is a
    // behaviour change tracked separately (#2218), not folded into this extraction.
    return scanLinesByRegex(ctx, {
      ruleId: "secrets-manager-forbidden",
      severity: "error",
      shouldInspect,
      lineRegex: SECRETS_MANAGER_IMPORT_RE,
      buildFinding: ({ line }) => {
        const name = line.match(SECRETS_MANAGER_IMPORT_RE)?.[1] ?? "secrets-manager";
        return {
          match: name,
          message: `AWS Secrets Manager is forbidden (per-secret cost). Import of ${name} detected.`,
          recommendation:
            "Store the secret in SSM Parameter Store as a SecureString (standard tier is free). " +
            "See CLAUDE.md cost-zero principle.",
        };
      },
    });
  },
};
