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

  it("keeps the least-privilege token: only the publishing job may write", () => {
    expect(workflow).toMatch(/ {4}permissions:\n {6}contents: write\n/);
    expect(workflow).toMatch(/ {4}permissions:\n {6}contents: read\n/);
    // Per job, never workflow-wide: a workflow-level block would hand the verifier write access.
    expect(workflow.match(/permissions:/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/\npermissions:/);
  });

  it("keeps the npm supply-chain overrides scoped to the pack and install steps", () => {
    expect(workflow).toContain("npm pack --no-ignore-scripts --min-release-age=7");
    expect(workflow).toContain('npm install -g --prefix "$PREFIX" "$TARBALL" --min-release-age=7');
  });
});

// #3024 PR 5. The release is only as trustworthy as what GitHub actually serves, so a second
// job re-verifies the published release from the outside. These assertions pin the properties
// that make that verification meaningful: it cannot run before publication, it reads the tagged
// tree, it requires the latest-download URL to serve this release, it installs the downloaded
// bytes rather than the built ones, and it records evidence even when it fails.
describe("published release verification contract", () => {
  it("runs only after the release is created, and never with write access", () => {
    expect(workflow).toMatch(/ {2}verify-published:\n {4}needs: release\n/);
    expect(workflow.indexOf("  verify-published:")).toBeGreaterThan(
      stepIndex("Create the release once, with every asset attached"),
    );
  });

  it("checks out the exact tag the release job resolved", () => {
    expect(workflow).toContain("ref: ${{ needs.release.outputs.tag }}");
    expect(workflow).toMatch(/ {4}outputs:\n {6}tag: \$\{\{ steps\.tag\.outputs\.tag \}\}\n/);
  });

  it("verifies the published artifacts, requiring the latest-download URL to serve this release", () => {
    expect(workflow).toContain("scripts/release/verify-published-release.ts");
    expect(workflow).toContain("--require-latest");
    expect(workflow).toContain('--evidence-out "$RUNNER_TEMP/published-release-evidence.json"');
  });

  it("installs the downloaded tarball, not the one the release job built", () => {
    expect(stepIndex("Verify the published release")).toBeLessThan(
      stepIndex("Install the published tarball outside the checkout and run it"),
    );
    expect(workflow).toContain('"$RUNNER_TEMP/published-assets/tenkacloud-cli-$VERSION.tgz"');
    expect(workflow).toContain('(cd /tmp && "$PREFIX/bin/tenkacloud" --help)');
  });

  it("records the evidence in the run summary even when a check fails", () => {
    expect(workflow).toMatch(
      / {6}- name: Publish the verification evidence to the run summary\n {8}#[^\n]*\n(?: {8}#[^\n]*\n)* {8}if: \$\{\{ !cancelled\(\) \}\}\n/,
    );
    expect(workflow).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });
});
