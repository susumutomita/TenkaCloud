import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * AWS GameDay 等の AWS official 競技プログラムが使う 「fictional company」 名は、
 * その branding が AWS の登録範囲 (および AWS Training の素材として) なので、
 * OSS / 商用配布する競技 platform 側で流用するのは IP リスク。
 *
 * 実害: もし TenkaCloud の問題本文や README に "Unicorn.Rentals" 等が残っていると、
 * AWS GameDay の derivative work と見なされかねない。 本 rule は新規 commit に
 * これらの名前が混入するのを防ぐ。
 *
 * 着想を得るのは自由 (= world-building の inspiration として AWS GameDay を参照するのは
 * 問題ない) だが、 具体的な fictional company 名 / character 名は独自に名乗ること。
 *
 * `docs/lore/world.html` のように 「AWS GameDay からの inspiration」 を明示する文脈で
 * 名前を comparison 目的で引きたい場合は、 行末 / 行内に `// allow-aws-fiction:` か
 * `<!-- allow-aws-fiction: ... -->` (HTML) のマーカーを置けば例外扱いになる。
 */

const FORBIDDEN_FICTION_NAMES: readonly RegExp[] = [
  // AWS GameDay: fictional unicorn-themed online retailer
  /\bUnicorn\s*\.?\s*Rentals?\b/i,
];

// AWS official 競技で使われる他の fictional name (将来追加できる枠)
// 例: /\bCookie\.\s*Plus\b/i (= AWS GameDay 別シナリオ) も同様に banned 候補

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".html",
  ".css",
  ".yaml",
  ".yml",
  ".sh",
  ".py",
]);

const ALLOW_MARKER = /allow-aws-fiction\b/;

function shouldScan(path: string): boolean {
  // 本 rule 自身 / そのテストは検査対象外 (rule 説明やテスト fixture が banned 文字列を含むため)
  if (path.endsWith("no-aws-trademark-fictions.ts")) return false;
  if (path.endsWith("no-aws-trademark-fictions.test.ts")) return false;
  // submodule 配下 (= problems/) は別 repo (TenkaCloudChallenge) 側でも独立に harness する想定だが、
  // main 側からも cross-check できるよう scan 対象に含める。
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return SCAN_EXTENSIONS.has(path.slice(dotIdx));
}

function findFirstForbidden(
  content: string,
): { line: number; match: string; pattern: string } | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    if (ALLOW_MARKER.test(l)) continue;
    for (const re of FORBIDDEN_FICTION_NAMES) {
      const m = re.exec(l);
      if (m) return { line: i + 1, match: m[0], pattern: re.source };
    }
  }
  return undefined;
}

export const noAwsTrademarkFictions: Rule = {
  id: "no-aws-trademark-fictions",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!shouldScan(path)) continue;
      let content: string;
      try {
        content = ctx.readFile(path);
      } catch {
        continue;
      }
      const hit = findFirstForbidden(content);
      if (!hit) continue;
      findings.push({
        ruleId: "no-aws-trademark-fictions",
        severity: "error",
        filePath: path,
        line: hit.line,
        match: hit.match,
        message: `AWS GameDay の fictional company 名 「${hit.match}」 が含まれています。 これは AWS 公式 training の branding で、 OSS / 商用配布する TenkaCloud で流用すると IP リスクになります。`,
        recommendation:
          "独自の fictional company 名 (例: Tenryu.Mart / Ryuou.Trade 等) に置き換えてください。 inspiration として AWS GameDay を 比較目的で引きたい場合のみ、 該当行末に `<!-- allow-aws-fiction: ... -->` (HTML) または `// allow-aws-fiction:` (code) を置けば exempt にできます。",
      });
    }
    return findings;
  },
};
