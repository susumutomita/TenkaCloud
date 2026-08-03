import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Issue #986 / SOLID 規律強制: 単一ファイルが 500 行を超えると Single Responsibility Principle
 * (SRP) 違反候補として警告する。 800 行を超えると error。
 *
 * SRP 違反は 1 ファイルに複数の責務が同居している状態 (= テストしにくい / 変更時に副作用が読めない
 * / レビュー困難)。 ある程度の閾値を harness で機械検査することで、 1 PR で 「ついで」 に
 * 500 行超のファイルを作るのを防ぐ。
 *
 * 既存違反は baseline で許容、 新規の違反だけ block する。 既存 file を baseline に登録した
 * あと、 同 file への新規追記で行数増加した場合は baseline match から外れるため再警告 (= 抑止力)。
 *
 * 対象拡張子: .ts / .tsx (= TypeScript の compile unit)。 .json / .md / .html は target 外
 * (= configuration / doc は責務分割の指標が違う)。
 *
 * 対象 path: \`infrastructure/lib/\`、 \`apps/<spa>/src/\`、 \`scripts/\`、 \`packages/<pkg>/src/\`。
 * test ファイル (`*.test.ts` / `*.test.tsx`) は除外 (= test は集中することが多く、 SRP 観点で
 * 別 axis)。 generated / dist / cdk.out も除外。
 *
 * 閾値:
 *   - 500 行超: warning (= 分割を検討)
 *   - 800 行超: error (= 必ず分割)
 *
 * 既存実態:
 *   - EventDetail.tsx 1150 行、 DeploymentDetail.tsx 830 行 等
 *   - これらは baseline で許容しつつ、 issue #986 Phase C / D で順次分割する
 */

const WARNING_LINES = 500;
const ERROR_LINES = 800;

// tech-debt/production-scope.ts と似ているが意図的に別物: この gate (STAGED file 検査) は
// `infrastructure/bin/` を含まない。 共通化するとゲートの検査対象が広がる (= 挙動変更) ため
// #2866 では統合しない。
const INCLUDE_PATH_PREFIXES = [
  "infrastructure/lib/",
  "apps/admin-console/src/",
  "apps/application-admin-console/src/",
  "apps/participant-portal/src/",
  "scripts/",
  "packages/portal-plugin-sdk/src/",
  "packages/trust-bridge/src/",
] as const;

const EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/, // test 系は SRP 別軸
  /\/node_modules\//,
  /\/dist\//,
  /\/cdk\.out\//,
  /\/__generated__\//,
  /\/__mocks__\//,
];

function shouldInspect(path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  return INCLUDE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export const fileTooLarge: Rule = {
  id: "file-too-large",
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
      const lineCount = content.split("\n").length;
      if (lineCount < WARNING_LINES) continue;
      const severity = lineCount >= ERROR_LINES ? "error" : "warning";
      findings.push({
        ruleId: "file-too-large",
        severity,
        filePath: path,
        line: 1,
        // match は baseline 識別に使う。 行数を含めると 1 行増減で baseline が外れて再警告するため、
        // bucket (= "≥500" / "≥800") だけにする。 同じ閾値範囲なら baseline match。
        match: severity === "error" ? "ge-800-lines" : "ge-500-lines",
        message: `${path} は ${lineCount} 行 (= ${
          severity === "error" ? `${ERROR_LINES}+ 行 SRP 違反` : `${WARNING_LINES}+ 行 SRP 候補`
        })。 単一ファイルに複数責務が同居している可能性が高い。`,
        recommendation:
          "責務単位で sub-module / sub-component に分割を検討してください。 例: " +
          "Lambda handler index.ts は routes (Hono routing) / service (business rule) / repository (SDK adapter) の 3 層に分割。 " +
          "React page は modal / table / form 等を sub-component に切り出し、 page 自体は orchestrator にする。 " +
          "Issue #986 (= SOLID 監査 epic) Phase B / C を参照。",
      });
    }
    return findings;
  },
};
