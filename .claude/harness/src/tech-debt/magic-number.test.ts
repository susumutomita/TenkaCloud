import { describe, expect, it } from "vitest";
import { extractIntegersFromLine, magicNumber, scanFile } from "./magic-number.ts";

const PROD_PATH = "infrastructure/lib/foo.ts";

describe("magic-number", () => {
  describe("HTTP status code detection", () => {
    it("should flag c.json(body, 500) as magic", () => {
      const code = ["function h(c: any) {", "  return c.json({}, 500);", "}"].join("\n");
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("http-status:500");
    });

    it("should flag res.status === 401 in production code", () => {
      const code = ["if (res.status === 401) throw new Error('auth');"].join("\n");
      const findings = magicNumber.check({
        files: ["apps/admin-console/src/api.ts"],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("http-status:401");
    });

    it("should not flag numbers outside http status hint context", () => {
      const code = "const cohortSize = 200;"; // 200 alone, no HTTP context
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });
  });

  describe("timeout / ms detection", () => {
    it("should flag setTimeout(..., 60000) as magic", () => {
      const code = "setTimeout(() => poll(), 60000);";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("timeout-ms:60000");
    });

    it("should flag `const POLL = 300_000;` only if context word is nearby", () => {
      // No timeout/delay/interval hint word, so we should NOT flag
      const code = "const POLL = 300_000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should flag pollingInterval: 30000 with hint word", () => {
      const code = "const cfg = { pollingInterval: 30000 };";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("timeout-ms:30000");
    });

    it("should NOT flag a SCREAMING_SNAKE named timeout constant (= the recommended named form)", () => {
      // `const POLL_INTERVAL_MS = 30_000;` contains the hint word "INTERVAL" but is
      // itself the named constant the rule asks for — flagging it would flag the fix.
      const code = "const POLL_INTERVAL_MS = 30_000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should NOT flag an exported named timeout constant", () => {
      const code = "export const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should still flag a bare timeout literal used at a call site", () => {
      // The exemption is only for the named declaration, not for bare uses.
      const code = "const NOTIFY_MS = 60_000;\nsetTimeout(() => setCopied(false), 30000);";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("timeout-ms:30000");
    });

    it("should still flag a camelCase numeric binding (only SCREAMING_SNAKE is the named form)", () => {
      const code = "const pollIntervalMs = 30000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
    });
  });

  describe("port detection", () => {
    it("should flag listen(3000) with port hint", () => {
      const code = "const port = 3000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe("port:3000");
    });

    it("should not flag 3000 in isolation without port/listen/url hint", () => {
      const code = "const cohortSize = 3000;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });
  });

  describe("exclusions", () => {
    it("should never flag 0, 1, -1, 2", () => {
      const code = "if (x === 0) return -1; if (y === 1) return 2;";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not flag numbers inside string literals", () => {
      const code = "const url = 'https://example.com:8080/api';";
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not flag numbers inside comments", () => {
      const code = ["// status === 500 is bad", "/* port 3000 */"].join("\n");
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not scan *.test.ts files", () => {
      const code = "if (res.status === 500) throw new Error();";
      const findings = magicNumber.check({
        files: ["apps/admin-console/src/foo.test.ts"],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not scan handlers/shared/http-status.ts (= legacy alias defn)", () => {
      const code = "export const HTTP_OK = 200;";
      const findings = magicNumber.check({
        files: ["infrastructure/lib/problem-deploy/handlers/shared/http-status.ts"],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not scan files outside production prefixes", () => {
      const code = "c.json({}, 500);";
      const findings = magicNumber.check({
        files: ["references/legacy.ts"],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });

    it("should not scan import lines (= path-internal digits are not magic)", () => {
      const code = 'import { Foo } from "./bar3000.ts";';
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(0);
    });
  });

  describe("dedup", () => {
    it("should emit 1 finding per (rule, value, kind) per file even if used many times", () => {
      const code = ["c.json({}, 500);", "c.json({}, 500);", "c.json({}, 500);"].join("\n");
      const findings = magicNumber.check({
        files: [PROD_PATH],
        readFile: () => code,
      });
      expect(findings).toHaveLength(1);
      // first occurrence's line
      expect(findings[0]?.line).toBe(1);
    });
  });

  describe("helpers", () => {
    it("extractIntegersFromLine should ignore identifier-suffix digits (= foo3)", () => {
      const r = extractIntegersFromLine("const foo3 = 42;", "code");
      expect(r.ints.map((i) => i.value)).toEqual([42]);
    });

    it("extractIntegersFromLine should handle underscore separators", () => {
      const r = extractIntegersFromLine("const x = 60_000;", "code");
      expect(r.ints.map((i) => i.value)).toEqual([60000]);
    });

    it("scanFile should respect multi-line block comments", () => {
      const src = ["/*", "  c.json({}, 500);", "*/", "const ok = true;"].join("\n");
      expect(scanFile(src)).toHaveLength(0);
    });
  });
});
