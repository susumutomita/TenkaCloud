import { describe, expect, it } from "vitest";
import { scanLinesByRegex } from "./scan-lines.ts";
import type { RuleContext } from "./types.ts";

/** Build a RuleContext from an in-memory { path: content } map. */
function ctxOf(files: Record<string, string>): RuleContext {
  return {
    files: Object.keys(files),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
  };
}

const baseOpts = {
  ruleId: "test-rule",
  severity: "error" as const,
  shouldInspect: (p: string) => p.endsWith(".ts"),
  lineRegex: /\bfetch\s*\(/,
  buildFinding: () => ({ match: "fetch(", message: "m", recommendation: "r" }),
};

describe("scanLinesByRegex", () => {
  it("should emit one finding per matching line with a 1-based line number", () => {
    const findings = scanLinesByRegex(
      ctxOf({ "a.ts": "const a = 1;\nawait fetch(url);\nfetch(other);\n" }),
      baseOpts,
    );
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
    expect(findings[0]).toMatchObject({
      ruleId: "test-rule",
      severity: "error",
      filePath: "a.ts",
      match: "fetch(",
    });
  });

  it("should skip files the shouldInspect predicate rejects", () => {
    const findings = scanLinesByRegex(
      ctxOf({ "keep.ts": "fetch(x);\n", "skip.js": "fetch(y);\n" }),
      baseOpts,
    );
    expect(findings.map((f) => f.filePath)).toEqual(["keep.ts"]);
  });

  it("should skip an unreadable file rather than throw", () => {
    const ctx: RuleContext = {
      files: ["broken.ts", "ok.ts"],
      readFile: (path) => {
        if (path === "broken.ts") throw new Error("boom");
        return "fetch(z);\n";
      },
    };
    const findings = scanLinesByRegex(ctx, baseOpts);
    expect(findings.map((f) => f.filePath)).toEqual(["ok.ts"]);
  });

  it("should pass the matching line text to buildFinding", () => {
    const findings = scanLinesByRegex(ctxOf({ "a.ts": "  await fetch(secretUrl);\n" }), {
      ...baseOpts,
      buildFinding: ({ line, lineNumber, path }) => ({
        match: line.trim(),
        message: `${path}:${lineNumber}`,
        recommendation: "r",
      }),
    });
    expect(findings[0]?.match).toBe("await fetch(secretUrl);");
    expect(findings[0]?.message).toBe("a.ts:1");
  });

  describe("stripComments", () => {
    const commented = [
      "// fetch(inLineComment);",
      "/* fetch(inOpenBlock);",
      "   fetch(insideBlock);",
      "*/",
      "* fetch(jsdocContinuation);",
      "fetch(realCall);",
    ].join("\n");

    it("should skip line and block comments when stripComments is true", () => {
      const findings = scanLinesByRegex(ctxOf({ "a.ts": commented }), {
        ...baseOpts,
        stripComments: true,
      });
      // Only the final bare call survives; every commented fetch( is skipped.
      expect(findings.map((f) => f.line)).toEqual([6]);
    });

    it("should NOT skip comment lines when stripComments is falsy (default)", () => {
      const findings = scanLinesByRegex(ctxOf({ "a.ts": commented }), baseOpts);
      // Default behaviour flags every line containing the pattern, comments included.
      expect(findings.length).toBeGreaterThan(1);
    });
  });
});
