import { describe, expect, it } from "vitest";
import { assertionRoulette, countExpectCalls, extractBlocks } from "./assertion-roulette.ts";

const TEST_PATH = "apps/admin-console/src/foo.test.ts";

describe("assertion-roulette", () => {
  it("should flag an it() block with 6 or more expect() calls as warning", () => {
    const code = [
      'import { describe, expect, it } from "vitest";',
      "",
      'it("should validate", () => {',
      "  expect(a).toBe(1);",
      "  expect(b).toBe(2);",
      "  expect(c).toBe(3);",
      "  expect(d).toBe(4);",
      "  expect(e).toBe(5);",
      "  expect(f).toBe(6);",
      "});",
    ].join("\n");
    const findings = assertionRoulette.check({
      files: [TEST_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("ge-6-expects");
  });

  it("should not flag an it() block with 5 expect() calls (= boundary)", () => {
    const code = [
      'it("should pass", () => {',
      "  expect(a).toBe(1);",
      "  expect(b).toBe(2);",
      "  expect(c).toBe(3);",
      "  expect(d).toBe(4);",
      "  expect(e).toBe(5);",
      "});",
    ].join("\n");
    const findings = assertionRoulette.check({
      files: [TEST_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should bucket 11+ expects into ge-11-expects so 1-call drift does not lose baseline", () => {
    const expects = new Array(12).fill("  expect(x).toBe(1);").join("\n");
    const code = `it("big", () => {\n${expects}\n});`;
    const findings = assertionRoulette.check({
      files: [TEST_PATH],
      readFile: () => code,
    });
    expect(findings[0]?.match).toBe("ge-11-expects");
  });

  it("should not count expect() inside string literals or comments", () => {
    const code = [
      'it("noise", () => {',
      "  // expect(a).toBe(1);",
      "  /* expect(b).toBe(2); */",
      '  const s = "expect(c).toBe(3)";',
      "  const t = `expect(d).toBe(4)`;",
      "  expect(real).toBe(1);",
      "});",
    ].join("\n");
    const findings = assertionRoulette.check({
      files: [TEST_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should treat nested it() blocks (= inside describe()) independently", () => {
    const code = [
      'describe("outer", () => {',
      '  it("first", () => {',
      "    expect(a).toBe(1);",
      "    expect(b).toBe(2);",
      "  });",
      '  it("second", () => {',
      "    expect(c).toBe(1);",
      "    expect(d).toBe(2);",
      "    expect(e).toBe(3);",
      "    expect(f).toBe(4);",
      "    expect(g).toBe(5);",
      "    expect(h).toBe(6);",
      "    expect(i).toBe(7);",
      "  });",
      "});",
    ].join("\n");
    const findings = assertionRoulette.check({
      files: [TEST_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("second");
  });

  it("should only inspect *.test.ts(x) files", () => {
    const code = [
      'it("not actually a test file", () => {',
      ...new Array(7).fill("  expect(a).toBe(1);"),
      "});",
    ].join("\n");
    const findings = assertionRoulette.check({
      files: ["apps/admin-console/src/util.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("countExpectCalls() should count expect() outside strings only", () => {
    expect(countExpectCalls("expect(a); expect(b);")).toBe(2);
    expect(countExpectCalls("'expect(a)'")).toBe(0);
    expect(countExpectCalls("`expect(a)`")).toBe(0);
    expect(countExpectCalls("// expect(a)")).toBe(0);
    expect(countExpectCalls("foo.expect(a)")).toBe(0); // member call != global expect
  });

  it("extractBlocks() should return the it() body without the wrapping braces", () => {
    const src = 'it("x", () => { expect(a); });';
    const blocks = extractBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.name).toBe("x");
    expect(blocks[0]?.body.trim()).toBe("expect(a);");
  });
});
