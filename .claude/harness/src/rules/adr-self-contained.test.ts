import { describe, expect, it } from "vitest";
import { adrSelfContained, findAdrSelfContainedViolations } from "./adr-self-contained.ts";

describe("adr-self-contained", () => {
  it("ADR HTML の chat 文脈を error にすべき", () => {
    const findings = adrSelfContained.check({
      files: ["docs/architecture/adr-999-new-decision.html"],
      readFile: () => "<p>今回は Claude が提案した内容を順次反映する。</p>",
    });

    expect(findings.map((finding) => finding.ruleId)).toEqual(["adr-self-contained"]);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.severity).toBe("error");
  });

  it("コードブロック内の fixture 表現は無視すべき", () => {
    const findings = findAdrSelfContainedViolations(
      "docs/architecture/adr-999-new-decision.html",
      "<pre><code>今回は fixture として残す</code></pre>",
    );

    expect(findings).toHaveLength(0);
  });

  it("ADR 以外の HTML は対象外にすべき", () => {
    const findings = adrSelfContained.check({
      files: ["docs/problems/AUTHORING.html"],
      readFile: () => "<p>今回は対象外</p>",
    });

    expect(findings).toHaveLength(0);
  });
});
