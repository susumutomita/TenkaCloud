import { describe, expect, it } from "vitest";
import { fileTooLarge } from "./file-too-large.ts";

function makeLines(n: number): string {
  return new Array(n).fill("x").join("\n");
}

describe("file-too-large", () => {
  it("infrastructure/lib/ 配下の 500 行超の .ts は warning すべき", () => {
    const findings = fileTooLarge.check({
      files: ["infrastructure/lib/big.ts"],
      readFile: () => makeLines(600),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("file-too-large");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("ge-500-lines");
  });

  it("800 行超は error にすべき", () => {
    const findings = fileTooLarge.check({
      files: ["infrastructure/lib/huge.ts"],
      readFile: () => makeLines(900),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("ge-800-lines");
  });

  it("499 行までは inspect しないべき", () => {
    const findings = fileTooLarge.check({
      files: ["infrastructure/lib/ok.ts"],
      readFile: () => makeLines(499),
    });
    expect(findings).toHaveLength(0);
  });

  it(".test.ts は対象外にすべき", () => {
    const findings = fileTooLarge.check({
      files: ["infrastructure/lib/big.test.ts"],
      readFile: () => makeLines(900),
    });
    expect(findings).toHaveLength(0);
  });

  it("対象 path prefix の外 (= references/, node_modules/) は inspect しないべき", () => {
    const findings = fileTooLarge.check({
      files: ["references/some-big-file.ts", "node_modules/lib/index.ts"],
      readFile: () => makeLines(900),
    });
    expect(findings).toHaveLength(0);
  });

  it("apps/admin-console/src/ も対象に入るべき", () => {
    const findings = fileTooLarge.check({
      files: ["apps/admin-console/src/pages/Big.tsx"],
      readFile: () => makeLines(600),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("scripts/ 配下も対象に入るべき", () => {
    const findings = fileTooLarge.check({
      files: ["scripts/big-tool.ts"],
      readFile: () => makeLines(850),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
  });

  it("match は bucket 文字列にして 1 行増減で baseline match を外さない設計とすべき", () => {
    const a = fileTooLarge.check({
      files: ["infrastructure/lib/x.ts"],
      readFile: () => makeLines(550),
    });
    const b = fileTooLarge.check({
      files: ["infrastructure/lib/x.ts"],
      readFile: () => makeLines(700),
    });
    expect(a[0]?.match).toBe(b[0]?.match);
  });
});
