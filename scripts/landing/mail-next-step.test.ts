import { describe, expect, test } from "bun:test";
import { buildMailShare } from "../../landing/mail-detective/next-step.js";

describe("optional mail result sharing", () => {
  test.each(["ja", "en"])("honest result, early stop and timeout in %s", (lang) => {
    for (const phase of ["results", "ended", "timed-out"]) {
      const result = buildMailShare(
        { phase, startLevel: 4, index: 1 },
        { found: 2, reviewed: 4, target: 6, mistakes: 3, score: 25, maxScore: 100, timeouts: 1 },
        lang,
      );
      expect(result).not.toBeNull();
      const intent = new URL(result.intent);
      expect(intent.origin + intent.pathname).toBe("https://x.com/intent/tweet");
      expect(intent.searchParams.get("text")).toBe(result.text);
      expect(intent.searchParams.get("url")).toBe(
        `https://tenkacloud.com/mail-detective/?lang=${lang}`,
      );
      expect(result.text).toContain("2/6");
      expect(result.text).toContain(
        lang === "ja" ? "得点 25/100・ミス 3" : "Score: 25/100 · Mistakes: 3",
      );
      expect(result.text).toContain("4/6");
      if (phase === "timed-out")
        expect(result.text).toContain(lang === "ja" ? "時間切れ" : "Time expired");
      expect(result.text).not.toContain("認定");
      expect(result.text).not.toContain("minamo");
      expect(result.text).not.toContain("DKIM");
    }
  });
  test("no premature sharing or fabricated non-finite scores", () => {
    expect(
      buildMailShare({ phase: "playing" }, { found: 6, reviewed: 0, target: 6 }, "ja"),
    ).toBeNull();
    expect(
      buildMailShare({ phase: "round-complete" }, { found: 3, reviewed: 0, target: 3 }, "en"),
    ).toBeNull();
    expect(
      buildMailShare(
        { phase: "ended", startLevel: 1, index: 0 },
        { found: Number.NaN, reviewed: Infinity, target: 1 },
        "ja",
      ).text,
    ).toContain("0/1");
  });
});
