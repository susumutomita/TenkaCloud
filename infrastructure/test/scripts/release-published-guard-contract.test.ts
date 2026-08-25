import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contract tests for the post-publish completeness guard (#3024 structural gap). Unlike
// release-workflow-contract.test.ts (which pins release-cli.yml's in-workflow, tag-push
// gated contract), these assertions pin that this workflow is triggered by the GitHub
// Release object itself — the `release: published` webhook event — so it runs no matter
// how the Release was created, not only when release-cli.yml built it.
const workflow = readFileSync(
  join(__dirname, "..", "..", "..", ".github", "workflows", "release-published-guard.yml"),
  "utf8",
);

describe("release published guard workflow contract", () => {
  it("triggers on the release published webhook event, not a tag push", () => {
    expect(workflow).toMatch(/\non:\n {2}release:\n {4}types: \[published\]\n/);
    expect(workflow).not.toMatch(/\n {2}push:\n {4}tags:/);
    expect(workflow).not.toContain("workflow_dispatch");
  });

  it("requests only read access, never contents: write", () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    // Anchored to an actual `permissions:` field, not the header prose that names
    // `contents: write` while explaining why the in-workflow contract alone is not enough.
    expect(workflow).not.toMatch(/\n {0,2}contents: write\n/);
  });

  it("never invokes a command that creates, uploads to, edits, or deletes a release or tag", () => {
    // Anchored to an indented, non-comment shell line (as release-workflow-contract.test.ts
    // does for "gh release create"), so the prose in this file's own header — which names
    // these commands to explain the gap — cannot make this assertion pass by accident.
    expect(workflow).not.toMatch(/\n {2,}gh release (create|upload|delete|edit)\b/);
    expect(workflow).not.toMatch(/\n {2,}git (tag|push)\b/);
  });

  it("checks out the default branch, not the release tag under test", () => {
    expect(workflow).not.toMatch(/ref: \$\{\{ *github\.event\.release\.tag_name/);
  });

  it("reads the webhook payload from GITHUB_EVENT_PATH, never interpolating it into a run step", () => {
    expect(workflow).toContain("scripts/release/check-release-published-completeness.ts");
    // The release event's own fields (tag name, body, name) must never be substituted
    // directly into a `run:` script — that is a documented GitHub Actions script-injection
    // shape. This workflow instead lets the script read GITHUB_EVENT_PATH itself. The one
    // legitimate use of the expression is the concurrency group below, which the Actions
    // runtime evaluates itself rather than expanding into a shell command.
    expect(workflow.match(/\$\{\{\s*github\.event\.release\./g)).toHaveLength(1);
    expect(workflow).toMatch(
      /concurrency:\n {2}group: release-published-guard-\$\{\{ github\.event\.release\.tag_name \}\}\n/,
    );
  });

  it("scopes concurrency to the release's own tag", () => {
    expect(workflow).toMatch(
      /concurrency:\n {2}group: release-published-guard-\$\{\{ github\.event\.release\.tag_name \}\}\n/,
    );
  });

  it("never opts a step out of failing the job", () => {
    expect(workflow).not.toContain("continue-on-error");
  });
});
