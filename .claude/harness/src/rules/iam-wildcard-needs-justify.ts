import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Issue #857: IAM `resources: ["*"]` の濫用を防ぐ harness rule。
 *
 * `infrastructure/lib/**` 配下で `resources: ["*"]` を含む行を発見したら、 直前 5 行以内に
 * `justify:` または `// PR #857:` または既存 issue 番号を含む comment が無いと error。
 *
 * 実用上 IAM Resource "*" は次の 4 つのケースで unavoidable:
 *   - CloudFormation Describe* / List* (= API design 上 ARN 不要)
 *   - KMS Decrypt with EncryptionContext condition (= 動的 key)
 *   - STS AssumeRole to cross-account dynamic role (= ARN を synth 時に知らない)
 *   - cloudwatch:PutMetricData (= Namespace condition で絞る)
 *
 * これらは Condition で scope を絞る or AWS API 制約由来。 ただし contributor が新しい
 * 経路で `*` を追加する時に 「なぜ wildcard が必要か」 の inline 説明を要求することで、
 * 不要な broad grant の混入を防ぐ。
 */

const STAR_RE = /resources:\s*\[\s*"\*"\s*\]/;

/** 直前 5 行 + 直後 10 行で justify の根拠と見なせるキーワード。 */
const JUSTIFY_KEYWORDS = [
  /\bjustify\s*:/i, // 「justify: <reason>」 形式
  /\bConditionExpression\b/, // DDB ConditionExpression
  /\bconditions\s*:/, // IAM PolicyStatement の Condition block (= scope を絞る)
  /\bStringEquals\b/, // IAM Condition operator
  /\bStringLike\b/, // IAM Condition operator
  /EncryptionContext/, // KMS scope
  /aws-api-required/i,
  /api design/i,
  /API 制約/, // 日本語
  /Issue #\d+/, // issue ref
  /PR #\d+/,
  /SBT vendored/, // serverless-saas-pipeline は SBT upstream
];

export const iamWildcardNeedsJustify: Rule = {
  id: "iam-wildcard-needs-justify",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    return ctx.files.flatMap((path) => findWildcardFindings(ctx, path));
  },
};

function findWildcardFindings(ctx: RuleContext, path: string): Finding[] {
  if (!path.startsWith("infrastructure/lib/") || !path.endsWith(".ts")) return [];
  try {
    return collectWildcardFindings(path, ctx.readFile(path).split("\n"));
  } catch {
    return [];
  }
}

function collectWildcardFindings(path: string, lines: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line || !STAR_RE.test(line) || hasNearbyJustification(lines, i)) continue;
    findings.push({
      ruleId: "iam-wildcard-needs-justify",
      severity: "error",
      filePath: path,
      line: i + 1,
      match: line.trim(),
      message:
        'IAM Resource wildcard (`resources: ["*"]`) を新規導入する場合、 直前 5 行以内に ' +
        "理由を明示する comment が必要 (`justify:` / `Condition` / `Issue #...` 等のキーワード)。",
      recommendation:
        "IAM Resource を具体 ARN に絞れないか再検討してください。 もし wildcard が必要なら、 " +
        "直前に `// justify: <reason>` の comment を入れてください。 例: " +
        "`// justify: CloudFormation Describe* は AWS API design 上 Resource 必須無し` 等。",
    });
  }
  return findings;
}

function hasNearbyJustification(lines: readonly string[], index: number): boolean {
  // 直前 10 行 + 直後 10 行 を inspect (= PolicyStatement の構造で `effect: / actions: /
  // resources:` の前に複数行 comment + addToRolePolicy 呼び出しが入るため、 5 行では
  // window が足りないケースが頻発する。 直後 10 行は同 PolicyStatement 内の Condition /
  // EncryptionContext を拾うため)。
  const start = Math.max(0, index - 10);
  const end = Math.min(lines.length, index + 10);
  const window = lines.slice(start, end).join("\n");
  return JUSTIFY_KEYWORDS.some((re) => re.test(window));
}
