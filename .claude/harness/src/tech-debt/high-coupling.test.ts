import { describe, expect, it } from "vitest";
import { countTopLevelImports, highCoupling } from "./high-coupling.ts";

function makeImports(n: number): string {
  return new Array(n)
    .fill(0)
    .map((_, i) => `import { x${i} } from "./m${i}.ts";`)
    .join("\n");
}

describe("high-coupling", () => {
  it("should flag a file with 16+ static imports as warning", () => {
    const code = makeImports(16);
    const findings = highCoupling.check({
      files: ["infrastructure/lib/big.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("ge-16-imports");
  });

  it("should not flag a file with 15 imports (= boundary)", () => {
    const code = makeImports(15);
    const findings = highCoupling.check({
      files: ["infrastructure/lib/ok.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should escalate to error at 41+ imports", () => {
    const code = makeImports(41);
    const findings = highCoupling.check({
      files: ["apps/admin-console/src/Page.tsx"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("ge-41-imports");
  });

  it("should bucket 26-40 imports as ge-26-imports", () => {
    const code = makeImports(30);
    const findings = highCoupling.check({
      files: ["infrastructure/lib/medium.ts"],
      readFile: () => code,
    });
    expect(findings[0]?.match).toBe("ge-26-imports");
  });

  it("should exclude *.test.ts files", () => {
    const code = makeImports(50);
    const findings = highCoupling.check({
      files: ["infrastructure/lib/foo.test.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should only count static imports — dynamic import() is ignored", () => {
    const code = [
      `const m1 = await import("./m1.ts");`,
      `const m2 = await import("./m2.ts");`,
      `const m3 = await import("./m3.ts");`,
    ].join("\n");
    expect(countTopLevelImports(code)).toBe(0);
  });

  it("should include `import type` because cognitive coupling is symmetric", () => {
    const code = new Array(16)
      .fill(0)
      .map((_, i) => `import type { T${i} } from "./t${i}.ts";`)
      .join("\n");
    const findings = highCoupling.check({
      files: ["apps/participant-portal/src/types.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
  });

  it("should only inspect files under target prefixes", () => {
    const code = makeImports(50);
    const findings = highCoupling.check({
      files: ["references/legacy.ts", "node_modules/lib/index.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
