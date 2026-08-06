import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_ONBOARDING_COMMANDS } from "../../../apps/participant-portal/src/auth/local-onboarding-contract";

/**
 * Issue #2696 PR 1: `make local-onboard` (Makefile:341-345) is a self-healing,
 * Bun-optional fresh-clone entry point that already existed but was referenced
 * nowhere in either README's local Quickstart. This file pins that both READMEs
 * now promote it inside the "Try it locally" / "ローカルで試す" section, ahead of
 * the manual command sequence it wraps.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const readmeEn = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const readmeJa = readFileSync(join(REPO_ROOT, "README.ja.md"), "utf8");
const localPlayManual = readFileSync(join(REPO_ROOT, "docs", "local-play.md"), "utf8");

function extractSection(markdown: string, startHeading: string, endHeading: string): string {
  const start = markdown.indexOf(startHeading);
  expect(start, `heading "${startHeading}" not found`).toBeGreaterThan(-1);
  const end = markdown.indexOf(endHeading, start);
  expect(end, `heading "${endHeading}" not found after "${startHeading}"`).toBeGreaterThan(-1);
  return markdown.slice(start, end);
}

function firstBashCommands(markdown: string): readonly string[] {
  const match = markdown.match(/```bash\n([^`]+)```/);
  expect(match, "bash command block not found").not.toBeNull();
  return (match?.[1] ?? "")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("README local quickstart references make local-onboard (Issue #2696)", () => {
  it("should reference make local-onboard inside the Try it locally section of README.md", () => {
    const section = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    expect(section).toContain("make local-onboard");
  });

  it("should reference make local-onboard inside the ローカルで試す section of README.ja.md", () => {
    const section = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    expect(section).toContain("make local-onboard");
  });

  it("should present make local-onboard before the manual-alternative <details> block in README.md", () => {
    const section = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    const onboardIndex = section.indexOf("make local-onboard");
    const detailsIndex = section.indexOf("<details>");
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeLessThan(detailsIndex);
  });

  it("should present make local-onboard before the manual-alternative <details> block in README.ja.md", () => {
    const section = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    const onboardIndex = section.indexOf("make local-onboard");
    const detailsIndex = section.indexOf("<details>");
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeLessThan(detailsIndex);
  });

  it("should describe make local-onboard as working without Bun preinstalled in both READMEs", () => {
    const enSection = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    expect(enSection).toMatch(/no Bun preinstall required/i);

    const jaSection = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    expect(jaSection).toMatch(/Bun の事前インストール不要/);
  });

  it("should keep the fresh-clone command contract identical in both READMEs", () => {
    const enSection = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    const jaSection = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    expect(firstBashCommands(enSection)).toEqual(LOCAL_ONBOARDING_COMMANDS);
    expect(firstBashCommands(jaSection)).toEqual(LOCAL_ONBOARDING_COMMANDS);
  });

  it("should publish the same fresh-clone command contract in the participant manual", () => {
    const runSection = extractSection(localPlayManual, "## Run it", "## The `/verify` contract");
    expect(firstBashCommands(runSection)).toEqual(LOCAL_ONBOARDING_COMMANDS);
  });
});
