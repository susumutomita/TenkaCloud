import { describe, expect, it } from "vitest";
import { adrMustBeHtml } from "./adr-must-be-html.ts";

describe("adr-must-be-html", () => {
  it("docs/architecture/adr-*.md が staged にある場合は error にすべき", () => {
    const findings = adrMustBeHtml.check({
      files: ["docs/architecture/adr-999-new-decision.md"],
      readFile: () => "",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("adr-must-be-html");
    expect(findings[0]?.severity).toBe("error");
  });

  it("harness.md は ADR ではないため許可すべき", () => {
    const findings = adrMustBeHtml.check({
      files: ["docs/architecture/harness.md"],
      readFile: () => "",
    });

    expect(findings).toHaveLength(0);
  });
});
