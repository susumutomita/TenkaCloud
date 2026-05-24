import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Git merge / rebase 中に残った conflict marker (`<<<<<<<` / `=======` / `>>>>>>>`)
 * が commit に紛れ込むのを防ぐ。 行頭にこれらが出現したらすべて error 扱い。
 *
 * 同様の検知は git の merge driver / pre-commit hook でも可能だが、 harness で再確認
 * することで:
 *   - rebase 中に conflict 解消し忘れた行を CI でも検知できる
 *   - reviewer が conflict marker を見落としても block できる
 *
 * 副作用: harness 自身のテストファイル等 (= 意図的に conflict marker をリテラルとして
 * 書きたい test fixture) は除外する必要がある。 ignore 対象は `.test.ts` 末尾を含む
 * パスのうち、 本 rule 自身のテスト (= `no-conflict-markers.test.ts`) のみ。
 */

const CONFLICT_MARKER_LINE_RE = /^(<<<<<<< |=======$|>>>>>>> )/m;
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".html",
  ".css",
  ".yaml",
  ".yml",
  ".sh",
]);

function shouldScan(path: string): boolean {
  // 本 rule 自身のテスト fixture は除外。 他に意図的に conflict marker をリテラルで
  // 書く必要が出てきたら、 ここに足す。
  if (path.endsWith("no-conflict-markers.test.ts")) return false;
  // 拡張子なし / バイナリ は scan しない
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return SCAN_EXTENSIONS.has(path.slice(dotIdx));
}

function findFirstMarkerLine(content: string): { line: number; match: string } | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    if (l.startsWith("<<<<<<< ") || l === "=======" || l.startsWith(">>>>>>> ")) {
      return { line: i + 1, match: l };
    }
  }
  return undefined;
}

export const noConflictMarkers: Rule = {
  id: "no-conflict-markers",
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
      // 高速 pre-check: marker パターンが含まれているか
      if (!CONFLICT_MARKER_LINE_RE.test(content)) continue;
      const hit = findFirstMarkerLine(content);
      if (!hit) continue;
      findings.push({
        ruleId: "no-conflict-markers",
        severity: "error",
        filePath: path,
        line: hit.line,
        match: hit.match,
        message:
          "Git merge / rebase 中に残った conflict marker が含まれています。 commit 前に必ず解消してください。",
        recommendation:
          "該当箇所 (= `<<<<<<<` / `=======` / `>>>>>>>` を含む行群) を編集して正しい内容を残し、 marker 自体を削除してから `git add` し直してください。 もし conflict 解消後に再度 PR ブランチを最新 main から rebase したい場合は `git fetch origin main && git rebase origin/main` を実行 (memory: feedback_pull_main_before_task)。",
      });
    }
    return findings;
  },
};
