import { describe, expect, it } from "vitest";
import { formatFindings, HelpRequested, loadTechDebtBaselines, parseArgs } from "./index.ts";

describe("tech-debt CLI", () => {
  describe("parseArgs", () => {
    it("should default to fail-on=warning and staged=false", () => {
      const opts = parseArgs([]);
      expect(opts.failOn).toBe("warning");
      expect(opts.staged).toBe(false);
      expect(opts.baseline).toBe(false);
    });

    it("should accept --staged and --fail-on=error", () => {
      const opts = parseArgs(["--staged", "--fail-on=error"]);
      expect(opts.staged).toBe(true);
      expect(opts.failOn).toBe("error");
    });

    it("should set baseline=true on --baseline", () => {
      const opts = parseArgs(["--baseline"]);
      expect(opts.baseline).toBe(true);
    });

    it("should throw HelpRequested on -h", () => {
      expect(() => parseArgs(["-h"])).toThrow(HelpRequested);
    });

    it("should reject unknown --fail-on values", () => {
      expect(() => parseArgs(["--fail-on=panic"])).toThrow(/--fail-on=/);
    });

    it("should reject unknown arguments", () => {
      expect(() => parseArgs(["--lol"])).toThrow(/Unknown argument/);
    });
  });

  describe("formatFindings", () => {
    it("should group output by ruleId and emit a header per rule", () => {
      const out = formatFindings([
        {
          ruleId: "magic-number",
          severity: "warning",
          filePath: "a.ts",
          line: 1,
          match: "http-status:500",
          message: "msg",
          recommendation: "rec",
        },
        {
          ruleId: "assertion-roulette",
          severity: "warning",
          filePath: "b.test.ts",
          line: 2,
          match: "ge-6-expects",
          message: "msg2",
          recommendation: "rec2",
        },
      ]);
      expect(out).toContain("tech-debt: 2 finding(s) across 2 rule(s).");
      expect(out).toContain("## magic-number (1)");
      expect(out).toContain("## assertion-roulette (1)");
    });

    it("should emit no-findings sentinel on empty input", () => {
      expect(formatFindings([])).toBe("tech-debt: no findings.\n");
    });
  });

  describe("loadTechDebtBaselines", () => {
    it("should return empty when dir is missing (ENOENT tolerant)", () => {
      const file = loadTechDebtBaselines("/tmp/definitely-does-not-exist-12345");
      expect(file.entries).toEqual([]);
    });
  });
});
