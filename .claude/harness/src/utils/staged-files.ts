import { execFileSync } from "node:child_process";

export interface StagedFilesOptions {
  readonly cwd: string;
}

/**
 * `git diff --cached --name-only --diff-filter=ACMR` 結果を行配列で返す。
 * Added / Copied / Modified / Renamed を対象、 Delete は除外 (= 削除されたファイルは検査不能)。
 * POSIX separator (= git の native) のまま、 caller が path match する。
 */
export function listStagedFiles(opts: StagedFilesOptions): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: opts.cwd,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 全 tracked ファイル (= `git ls-files`) を返す。 `--staged` 指定無しの full scan モード用。
 */
export function listAllTrackedFiles(opts: StagedFilesOptions): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: opts.cwd, encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
