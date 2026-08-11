#!/usr/bin/env bun
/**
 * `eslint.config.js` の ignores が `.gitignore` から drift していないことを検査する。
 *
 * なぜ要るか: repo 全体 lint (`eslint . --max-warnings 0`) を bulk suppressions の ceiling
 * 付きで gate 化した時点で、「ESLint が何 file を見るか」が gate の正しさそのものになった。
 * ignores が漏れると ESLint は生成物や nested worktree まで歩き、 ceiling は その machine に
 * しか存在しない file を含んで焼かれる。 実際に起きた: `.next` / `out` / `.claude/worktrees`
 * が漏れた状態の `eslint .` は 15,640 file / 186,110 error を報告し、 repo が実際に所有する
 * 2,086 file / 1,694 error をその中に埋もれさせていた。
 *
 * 検査方法: git が無視する directory を ESLint 自身に渡し、 ESLint が「lint する」と答えた
 * file を finding にする。 ignore pattern を再実装して当てにいくのではなく ESLint の walker に
 * 判定させるので、 pattern の書き間違いも後段 config による上書きもそのまま出る
 * (= `make check-synth` と同じ「source ではなく実効値を見る」方針)。 判定を自前の heuristic で
 * 近似した初版は `apps/landing-page/` を誤検出した — 配下の lint 対象 file が全て `dist/`
 * (ESLint が既に無視) にあったため。
 *
 * 限界: git-ignored な path は machine ごとに違う (build 前の CI には `.next` も
 * `.claude/worktrees` も無い)。 CI が緑でも手元の file set が健全である証明にはならないので、
 * これは「手元で踏んだ drift をその場で落とす」ための gate であって CI 専用の invariant では
 * ない。 だからこそ `make lint` 経由で before-commit にも載せてある。
 *
 * 使い方:
 *   bun run scripts/quality/check-eslint-scope.ts    — drift があれば exit 1
 */

import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { compareCodePoints } from "../lib/code-point-order";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `git ls-files --others --ignored --exclude-standard --directory` の出力から directory entry
 * だけを取り出す。 `--directory` は「丸ごと無視される directory」を 1 行に畳むので、 残る個別
 * file 行 (`.DS_Store` / `.env` 等) は lint 対象になり得ず捨ててよい。
 */
export function parseIgnoredDirectories(gitOutput: string): string[] {
  return gitOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("/"))
    .map((line) => line.slice(0, -1))
    .filter((line) => line.length > 0);
}

export function formatFindings(lintedPaths: readonly string[]): string {
  return [
    "NG .gitignore が無視する path を ESLint が lint 対象に含めています:",
    ...lintedPaths.map((path) => `  ${path}`),
    "",
    "生成物や nested worktree を lint すると、 ceiling (eslint-suppressions.json) が その machine",
    "にしか無い file を含んで焼かれ、 CI と手元で結果が一致しなくなります。 上記を覆う pattern を",
    "eslint.config.js の ignores に足してください。",
  ].join("\n");
}

const GIT_IGNORED_DIRS_ARGS = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--directory",
];

function listIgnoredDirectories(): string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is this gate's input source
  const result = spawnSync("git", GIT_IGNORED_DIRS_ARGS, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (status ${String(result.status)}): ${result.stderr}`);
  }
  return parseIgnoredDirectories(result.stdout);
}

/** 検査に必要な ESLint の能力だけを表す。 test から fake を渡せるよう構造型で受ける。 */
export interface FileLinter {
  lintFiles(patterns: string[]): Promise<readonly { readonly filePath: string }[]>;
}

/**
 * ESLint が実際に lint する file を repo 相対 path で返す。 `warnIgnored: false` により、
 * 既に ignores が覆っている directory は結果に現れない — 残ったものだけが drift。
 */
export async function lintedPathsUnder(
  linter: FileLinter,
  directories: readonly string[],
): Promise<string[]> {
  if (directories.length === 0) return [];
  const results = await linter.lintFiles([...directories]);
  return results.map((result) => relative(REPO_ROOT, result.filePath)).sort(compareCodePoints);
}

export async function main(): Promise<number> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    errorOnUnmatchedPattern: false,
    warnIgnored: false,
  });
  const findings = await lintedPathsUnder(eslint, listIgnoredDirectories());
  if (findings.length === 0) {
    console.log("OK ESLint の lint 対象は .gitignore と整合しています。");
    return 0;
  }
  console.error(formatFindings(findings));
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
