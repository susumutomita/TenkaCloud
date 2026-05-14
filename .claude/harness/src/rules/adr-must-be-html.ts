import type { Finding, Rule, RuleContext } from "../types.ts";

const ADR_MD_RE = /^docs\/architecture\/adr-[a-z0-9-]+\.md$/i;

export const adrMustBeHtml: Rule = {
  id: "adr-must-be-html",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!ADR_MD_RE.test(path)) continue;
      findings.push({
        ruleId: "adr-must-be-html",
        severity: "error",
        filePath: path,
        message:
          "ADR は HTML で書く運用 (memory: feedback_design_docs_html)。md ソースを置くと表現力 (row span / color / SVG / collapsible) が失われ、build-docs が上書き対象に取り込んでしまう。",
        recommendation: `${path} を ${path.replace(/\.md$/, ".html")} に書き直して、 ${path} は git rm で削除してください。 既存の手書き HTML ADR (例: docs/architecture/adr-012-problem-plugin-architecture.html) をテンプレに参考にできます。`,
      });
    }
    return findings;
  },
};
