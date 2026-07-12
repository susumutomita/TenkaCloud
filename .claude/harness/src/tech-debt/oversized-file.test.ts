import { describe, expect, it } from "vitest";
import { oversizedFile } from "./oversized-file.ts";

function fileOf(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join("\n");
}

describe("oversized-file", () => {
  it("should warn on a production file over 400 lines", () => {
    const findings = oversizedFile.check({
      files: ["infrastructure/lib/problem-deploy/some-module.ts"],
      readFile: () => fileOf(401),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("oversized-file");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("gt-400-lines");
  });

  it("should error on a production file over 800 lines", () => {
    const findings = oversizedFile.check({
      files: ["apps/participant-portal/src/components/Big.tsx"],
      readFile: () => fileOf(801),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("gt-800-lines");
  });

  it("should stay silent at exactly the 400-line boundary", () => {
    const findings = oversizedFile.check({
      files: ["scripts/tenkacloud-local.ts"],
      readFile: () => fileOf(400),
    });
    expect(findings).toHaveLength(0);
  });

  it("should keep the warning bucket at exactly 800 lines (error is strictly greater)", () => {
    const findings = oversizedFile.check({
      files: ["scripts/tenkacloud-local.ts"],
      readFile: () => fileOf(800),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("should skip test files and generated output", () => {
    const findings = oversizedFile.check({
      files: [
        "infrastructure/test/problem-deploy/huge.test.ts",
        "infrastructure/lib/foo.test.ts",
        "apps/admin-console/src/__generated__/big.ts",
        "infrastructure/cdk.out/asset.ts",
      ],
      readFile: () => fileOf(1000),
    });
    expect(findings).toHaveLength(0);
  });

  it("should skip files outside the production include roots", () => {
    const findings = oversizedFile.check({
      files: ["docs/architecture/big-reference.ts", "landing/generator.ts"],
      readFile: () => fileOf(1000),
    });
    expect(findings).toHaveLength(0);
  });
});
