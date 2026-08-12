import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contract tests for the unified release workflow (#3024 PR 3). The workflow is bash
// inside YAML, so these assertions pin the ordering and fail-closed structure that the
// issue requires: identity validation and release gates before any build, hashing and
// attestation before publication, and exactly one release-creation path.
const workflow = readFileSync(
  join(__dirname, "..", "..", "..", ".github", "workflows", "release-cli.yml"),
  "utf8",
);

function stepIndex(name: string): number {
  const index = workflow.indexOf(`- name: ${name}`);
  if (index === -1) throw new Error(`workflow step not found: ${name}`);
  return index;
}

describe("release workflow contract", () => {
  it("validates the tag shape before anything else", () => {
    expect(workflow).toContain('if [[ ! "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(stepIndex("Resolve the target tag")).toBeLessThan(stepIndex("Check out the code"));
  });

  it("checks out the exact tag, not a branch", () => {
    expect(workflow).toContain("ref: ${{ steps.tag.outputs.tag }}");
  });

  it("resolves the release identity and runs the release gates before building", () => {
    expect(workflow).toContain("scripts/release/verify-release-identity.ts --tag");
    expect(stepIndex("Resolve and validate the release identity")).toBeLessThan(
      stepIndex("Run the release drift and publication gates"),
    );
    expect(stepIndex("Run the release drift and publication gates")).toBeLessThan(
      stepIndex("Build the CLI tarball (prepack assembles the bundled runtime)"),
    );
    expect(workflow).toContain("bun run release:check");
  });

  it("smoke tests before assembling assets, and hashes before attesting", () => {
    expect(stepIndex("Smoke test the packed tarball")).toBeLessThan(
      stepIndex("Assemble the release asset set and SHA256SUMS"),
    );
    expect(stepIndex("Assemble the release asset set and SHA256SUMS")).toBeLessThan(
      stepIndex("Generate the release attestation"),
    );
    expect(stepIndex("Generate the release attestation")).toBeLessThan(
      stepIndex("Create the release once, with every asset attached"),
    );
  });

  it("ships the closed six-asset set and creates the release exactly once", () => {
    for (const asset of [
      'tenkacloud-cli-$VERSION.tgz"',
      "tenkacloud-cli.tgz",
      "release-manifest.json",
      "release-report.md",
      "SHA256SUMS",
      "release-attestation.json",
    ]) {
      expect(workflow).toContain(asset);
    }
    // Count command invocations only; prose comments also mention the command name.
    expect(workflow.match(/\n +gh release create "/g)).toHaveLength(1);
    expect(workflow).toContain("--generate-notes");
  });

  it("keeps the least-privilege token: contents write only, no extra permissions", () => {
    expect(workflow).toMatch(/permissions:\n {2}contents: write\n/);
    expect(workflow.match(/permissions:/g)).toHaveLength(1);
  });

  it("keeps the npm supply-chain overrides scoped to the pack and install steps", () => {
    expect(workflow).toContain("npm pack --no-ignore-scripts --min-release-age=7");
    expect(workflow).toContain('npm install -g --prefix "$PREFIX" "$TARBALL" --min-release-age=7');
  });
});
