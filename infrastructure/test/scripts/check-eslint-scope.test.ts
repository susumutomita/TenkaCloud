import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FileLinter,
  formatFindings,
  lintedPathsUnder,
  parseIgnoredDirectories,
} from "../../../scripts/quality/check-eslint-scope";

/**
 * #3014: repo 全体 ESLint の ceiling (eslint-suppressions.json) は「ESLint が何 file を見るか」
 * が machine 間で一致して初めて意味を持つ。 この gate は git が無視する path を ESLint が
 * lint 対象にしていたら落とす。 ここでは判定の純粋部分を pin する。
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function fakeLinter(filePaths: readonly string[]): FileLinter & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    seen,
    lintFiles(patterns: string[]) {
      seen.push(patterns);
      return Promise.resolve(filePaths.map((filePath) => ({ filePath })));
    },
  };
}

describe("parseIgnoredDirectories", () => {
  it("should keep only directory entries and strip the trailing slash", () => {
    expect(parseIgnoredDirectories("apps/developer-portal/.next/\ncdk.out/\n")).toEqual([
      "apps/developer-portal/.next",
      "cdk.out",
    ]);
  });

  it("should drop individual file entries, which cannot widen the lint scope on their own", () => {
    // `--directory` collapses fully-ignored directories; whatever is left as a bare path is a
    // single ignored file (.DS_Store / .env). Those never pull new files into `eslint .`.
    expect(parseIgnoredDirectories(".DS_Store\n.env\ntmp/\n")).toEqual(["tmp"]);
  });

  it("should tolerate blank lines and surrounding whitespace from git output", () => {
    expect(parseIgnoredDirectories("\n  coverage/  \n\n")).toEqual(["coverage"]);
  });
});

describe("lintedPathsUnder", () => {
  it("should report repo-relative paths sorted, so the failure message is stable", async () => {
    const linter = fakeLinter([resolve(REPO_ROOT, "tmp/b.mjs"), resolve(REPO_ROOT, "tmp/a.mjs")]);
    await expect(lintedPathsUnder(linter, ["tmp"])).resolves.toEqual(["tmp/a.mjs", "tmp/b.mjs"]);
  });

  it("should report nothing when ESLint already ignores every candidate directory", async () => {
    // ESLint is constructed with `warnIgnored: false`, so a covered directory yields no results.
    await expect(lintedPathsUnder(fakeLinter([]), ["cdk.out", "coverage"])).resolves.toEqual([]);
  });

  it("should not invoke ESLint when git reports no ignored directories", async () => {
    const linter = fakeLinter([resolve(REPO_ROOT, "unexpected.ts")]);
    // `lintFiles([])` lints the whole cwd, which would turn an empty candidate set into a
    // repo-wide false positive.
    await expect(lintedPathsUnder(linter, [])).resolves.toEqual([]);
    expect(linter.seen).toEqual([]);
  });
});

describe("formatFindings", () => {
  it("should name every offending path and point at the config that must change", () => {
    const message = formatFindings(["tmp/a.mjs", "tmp/b.mjs"]);
    expect(message).toContain("tmp/a.mjs");
    expect(message).toContain("tmp/b.mjs");
    expect(message).toContain("eslint.config.js");
  });
});
