import { describe, expect, it } from "bun:test";
import { mergeLcov, parseArgs, UsageError } from "./merge-lcov.ts";

/** One part's report: the whole file list, only this part's hit counts. */
const PART_A = `TN:
SF:/repo/infrastructure/lib/a.ts
FN:1,alpha
FN:5,beta
FNDA:2,alpha
FNDA:0,beta
FNF:2
FNH:1
BRDA:3,0,0,1
BRDA:3,0,1,-
BRF:2
BRH:1
DA:1,2
DA:2,0
DA:5,0
LF:3
LH:1
end_of_record
`;

const PART_B = `TN:
SF:/repo/infrastructure/lib/a.ts
FN:1,alpha
FN:5,beta
FNDA:0,alpha
FNDA:7,beta
FNF:2
FNH:1
BRDA:3,0,0,-
BRDA:3,0,1,4
BRF:2
BRH:1
DA:1,0
DA:2,3
DA:5,7
LF:3
LH:2
end_of_record
`;

function recordOf(lcov: string, path: string): string[] {
  const lines = lcov.split("\n");
  const start = lines.indexOf(`SF:${path}`);
  const end = lines.indexOf("end_of_record", start);
  return lines.slice(start, end + 1);
}

describe("mergeLcov", () => {
  const merged = mergeLcov([PART_A, PART_B]);
  const record = recordOf(merged, "/repo/infrastructure/lib/a.ts");

  it("should emit one record per source file instead of concatenating the parts", () => {
    expect(merged.split("SF:").length - 1).toBe(1);
    expect(merged.split("end_of_record").length - 1).toBe(1);
  });

  it("should sum DA counts for the same line across parts", () => {
    expect(record).toContain("DA:1,2");
    expect(record).toContain("DA:2,3");
    expect(record).toContain("DA:5,7");
  });

  /**
   * The regression this file exists for: concatenating parts makes `parseLcovPerFile` (the infra
   * ratchet's reader) sum LF across records, so a 3-line file seen by 2 parts reads as 6 lines
   * found — and the ratchet sees a halved percentage for a file whose coverage never changed.
   */
  it("should recompute LF/LH from the merged lines rather than adding the parts' totals", () => {
    expect(record).toContain("LF:3");
    expect(record).toContain("LH:3");
  });

  it("should sum FNDA per function name and recompute FNF/FNH", () => {
    expect(record).toContain("FNDA:2,alpha");
    expect(record).toContain("FNDA:7,beta");
    expect(record).toContain("FNF:2");
    expect(record).toContain("FNH:2");
  });

  it("should sum BRDA per (line, block, branch) and recompute BRF/BRH", () => {
    expect(record).toContain("BRDA:3,0,0,1");
    expect(record).toContain("BRDA:3,0,1,4");
    expect(record).toContain("BRF:2");
    expect(record).toContain("BRH:2");
  });

  it("should keep a branch no part reached as `-` so it stays counted in BRF but not BRH", () => {
    const untaken = mergeLcov([
      "SF:/repo/x.ts\nBRDA:1,0,0,-\nBRF:1\nBRH:0\nDA:1,0\nLF:1\nLH:0\nend_of_record\n",
      "SF:/repo/x.ts\nBRDA:1,0,0,-\nBRF:1\nBRH:0\nDA:1,0\nLF:1\nLH:0\nend_of_record\n",
    ]);
    expect(untaken).toContain("BRDA:1,0,0,-");
    expect(untaken).toContain("BRF:1");
    expect(untaken).toContain("BRH:0");
  });

  it("should keep files that only one part reported", () => {
    const both = mergeLcov([PART_A, "SF:/repo/infrastructure/lib/b.ts\nDA:1,1\nend_of_record\n"]);
    expect(both).toContain("SF:/repo/infrastructure/lib/a.ts");
    expect(both).toContain("SF:/repo/infrastructure/lib/b.ts");
  });

  it("should be a no-op on a single report's coverage numbers", () => {
    const single = recordOf(mergeLcov([PART_A]), "/repo/infrastructure/lib/a.ts");
    expect(single).toContain("LF:3");
    expect(single).toContain("LH:1");
    expect(single).toContain("FNH:1");
  });

  it("should return an empty string when there is nothing to merge", () => {
    expect(mergeLcov([])).toBe("");
    expect(mergeLcov(["", "\n"])).toBe("");
  });
});

describe("parseArgs", () => {
  it("should read --out and the input list", () => {
    expect(parseArgs(["--out", "merged.info", "a.info", "b.info"])).toEqual({
      out: "merged.info",
      inputs: ["a.info", "b.info"],
    });
  });

  it("should reject a missing --out, missing inputs, and unknown flags", () => {
    expect(() => parseArgs(["a.info"])).toThrow(UsageError);
    expect(() => parseArgs(["--out", "merged.info"])).toThrow(UsageError);
    expect(() => parseArgs(["--out", "merged.info", "--nope", "a.info"])).toThrow(UsageError);
  });
});
