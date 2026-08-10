import { describe, expect, it, vi } from "vitest";
import {
  formatLocalProblemListing,
  type ListedProblem,
  listingColumnWidths,
} from "../../../scripts/local-play/catalog-listing";

/**
 * [#3008] `tenkacloud local list` must tell a participant *before* they pick a problem that
 * their machine cannot run it — and why. The rows are returned rather than printed so the
 * formatting is pinned here without capturing stdout.
 */

const problems: readonly ListedProblem[] = [
  { problemId: "sqli-demo", name: "SQLi", category: "challenges" },
  {
    problemId: "asm-worst-case-latency",
    name: "Slowest instruction",
    category: "challenges",
    compatibility: { nativeArchitectures: ["amd64"] },
  },
];

const supported = () => ({ supported: true }) as const;
const refuse = (id: string) =>
  vi.fn((problemId: string) =>
    problemId === id
      ? ({
          supported: false,
          code: "unsupported_architecture",
          message: "needs a native amd64 CPU; this machine is arm64",
          messageJa: "native な amd64 CPU が必要ですが、 このマシンは arm64 です",
        } as const)
      : supported(),
  );

describe("listingColumnWidths (#3008)", () => {
  it("should fit the longest row and never shrink below the header labels", () => {
    expect(listingColumnWidths(problems)).toEqual({
      idWidth: "asm-worst-case-latency".length,
      categoryWidth: "challenges".length,
    });
    expect(listingColumnWidths([{ problemId: "a", name: "A", category: "b" }])).toEqual({
      idWidth: "id".length,
      categoryWidth: "category".length,
    });
  });
});

describe("formatLocalProblemListing (#3008)", () => {
  it("should list every problem unmarked when the host can run them all", () => {
    const lines = formatLocalProblemListing(problems, supported);
    expect(lines).toHaveLength(3); // header + 2 rows, no explanation block
    expect(lines.join("\n")).not.toContain("not startable");
  });

  it("should mark only the problem this machine cannot run", () => {
    const lines = formatLocalProblemListing(problems, refuse("asm-worst-case-latency"));
    const [, sqli, asm] = lines;
    expect(sqli).not.toContain("not startable");
    expect(asm).toContain("[not startable on this machine]");
  });

  it("should keep the unsupported problem listed rather than hiding it", () => {
    // Hiding it would be indistinguishable from a problem that was never authored, and the
    // participant would never learn their machine is the reason.
    const lines = formatLocalProblemListing(problems, refuse("asm-worst-case-latency"));
    expect(lines.join("\n")).toContain("asm-worst-case-latency");
  });

  it("should explain each refusal in both languages after the table", () => {
    const lines = formatLocalProblemListing(problems, refuse("asm-worst-case-latency"));
    const explanation = lines.slice(3);
    expect(explanation[0]).toBe("");
    expect(explanation[1]).toContain("needs a native amd64 CPU");
    expect(explanation[2]).toContain("native な amd64 CPU が必要");
  });

  it("should pad the columns so the rows line up", () => {
    const [header, sqli] = formatLocalProblemListing(problems, supported);
    const { idWidth, categoryWidth } = listingColumnWidths(problems);
    expect(header).toBe(`  ${"id".padEnd(idWidth)}  ${"category".padEnd(categoryWidth)}  name`);
    expect(sqli).toBe(
      `  ${"sqli-demo".padEnd(idWidth)}  ${"challenges".padEnd(categoryWidth)}  SQLi`,
    );
  });
});
