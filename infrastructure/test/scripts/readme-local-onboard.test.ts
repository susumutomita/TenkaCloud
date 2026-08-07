import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_ONBOARDING_COMMANDS } from "../../../apps/participant-portal/src/auth/local-onboarding-contract";

/**
 * Issue #2906: the participant fresh-clone path is Docker-only (Git, Make,
 * Docker Engine, Docker Compose v2 — no Bun/Node/node_modules), pinned via
 * LOCAL_ONBOARDING_COMMANDS. `make local-onboard` (Makefile) now only matters
 * for the developer Bun/Vite hot-reload path (`make local-dev`), so this file
 * pins that it lives inside — not ahead of — the collapsed developer
 * `<details>` block in both READMEs, and that the primary section states the
 * Docker-only prerequisites plainly. (Supersedes the Issue #2696 version of
 * this file, which pinned the previous self-healing-Bun story.)
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

describe("README local quickstart is Docker-only, make local-onboard is developer-only (Issue #2906)", () => {
  it("should scope make local-onboard to the developer details block in README.md", () => {
    const section = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    expect(section).toContain("make local-onboard");
  });

  it("should scope make local-onboard to the developer details block in README.ja.md", () => {
    const section = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    expect(section).toContain("make local-onboard");
  });

  it("should present make local-onboard INSIDE the developer <details> block in README.md, not the primary path", () => {
    const section = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    const onboardIndex = section.indexOf("make local-onboard");
    const detailsIndex = section.indexOf("<details>");
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeGreaterThan(detailsIndex);
  });

  it("should present make local-onboard INSIDE the developer <details> block in README.ja.md, not the primary path", () => {
    const section = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    const onboardIndex = section.indexOf("make local-onboard");
    const detailsIndex = section.indexOf("<details>");
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeGreaterThan(detailsIndex);
  });

  it("should state the Docker-only prerequisites (no Bun/Node/node_modules) in both READMEs", () => {
    const enSection = extractSection(readmeEn, "### Try it locally (no AWS)", "### Deploy on AWS");
    expect(enSection).toMatch(/no Bun, Node, or `node_modules`/i);

    const jaSection = extractSection(
      readmeJa,
      "### ローカルで試す(AWS 不要)",
      "### AWS にデプロイする",
    );
    expect(jaSection).toMatch(/Bun・Node・`node_modules` はホストに不要/);
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
