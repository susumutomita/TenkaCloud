import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2696 PR 1: README.md is the source of truth and README.ja.md must track
 * it (see the "英語版が正本" note near the top of README.ja.md). Heading TEXT is
 * language-specific and can't be compared directly, but the ordered ## / ###
 * heading-level sequence is a structural invariant both files must share — a
 * skipped or reordered section in one language is a silent parity drift that
 * `make validate-problems` (#2254, catalog READMEs) does not catch for the repo
 * root README pair. This file closes that gap for README.md / README.ja.md.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const readmeEn = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const readmeJa = readFileSync(join(REPO_ROOT, "README.ja.md"), "utf8");

/** Ordered ## / ### heading levels, ignoring the level-1 title and any `#`-led
 *  text inside fenced code blocks (those never match `##`/`###`). */
function headingLevels(markdown: string): readonly string[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{2,3}\s/.test(line))
    .map((line) => (line.startsWith("### ") ? "###" : "##"));
}

describe("README.md / README.ja.md heading structure parity (Issue #2696)", () => {
  const enLevels = headingLevels(readmeEn);
  const jaLevels = headingLevels(readmeJa);

  it("should find at least one heading in each file (sanity guard against an empty match)", () => {
    expect(enLevels.length).toBeGreaterThan(0);
    expect(jaLevels.length).toBeGreaterThan(0);
  });

  it("should have the same number of ## / ### headings in both languages", () => {
    expect(jaLevels.length).toBe(enLevels.length);
  });

  it("should have a 1:1 positional heading-level correspondence between README.md and README.ja.md", () => {
    expect(jaLevels).toEqual(enLevels);
  });
});
