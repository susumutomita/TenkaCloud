import { describe, expect, it } from "vitest";
import { noAwsTrademarkFictions } from "./no-aws-trademark-fictions.ts";

function ctx(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
  };
}

describe("noAwsTrademarkFictions", () => {
  it("should pass when no AWS-branded fictional company names are referenced", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "README.md": "TenkaCloud is a cloud competition platform.",
        "apps/foo/src/bar.ts": "const company = 'Tenryu.Mart';",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should flag `Unicorn.Rentals` (= AWS GameDay branding) in README.md", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "README.md": "Keep Unicorn.Rentals returning 200 while under attack.",
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.ruleId).toBe("no-aws-trademark-fictions");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.match).toBe("Unicorn.Rentals");
  });

  it("should flag `Unicorn Rentals` (= space variant) in metadata.json", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "problems/foo/metadata.json": '{"shortDescription": "the famous Unicorn Rentals scenario"}',
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.match).toBe("Unicorn Rentals");
  });

  it("should match case-insensitively (`unicorn.rentals`)", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "docs/foo.md": "inspired by unicorn.rentals",
      }),
    );
    expect(findings.length).toBe(1);
  });

  it("should NOT flag a line carrying an `allow-aws-fiction:` exemption marker", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "docs/lore/world.html":
          "<p>Inspired by competitions like Unicorn.Rentals.<!-- allow-aws-fiction: comparison only --></p>",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should NOT flag a line that documents the rule itself by its own id (e.g. CLAUDE.md's rule table)", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "CLAUDE.md":
          '- `no-aws-trademark-fictions` — blocks AWS GameDay-style fictional company/character names (e.g. "Unicorn.Rentals") from being reused in TenkaCloud content',
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should still flag a genuine `Unicorn.Rentals` usage elsewhere in CLAUDE.md that does not mention the rule id", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "CLAUDE.md": "Keep Unicorn.Rentals returning 200 while under attack.",
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.match).toBe("Unicorn.Rentals");
  });

  it("should not scan its own source / test file (= fixtures contain banned strings)", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        ".claude/harness/src/rules/no-aws-trademark-fictions.ts": "Unicorn.Rentals",
        ".claude/harness/src/rules/no-aws-trademark-fictions.test.ts": "Unicorn.Rentals",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should ignore non-text extensions", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "assets/image.png": "Unicorn.Rentals (binary content)",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should scan `.html` files (e.g. `docs/lore/world.html`)", () => {
    const findings = noAwsTrademarkFictions.check(
      ctx({
        "docs/lore/world.html": "<p>references Unicorn.Rentals scenario</p>",
      }),
    );
    expect(findings.length).toBe(1);
  });
});
