/**
 * [Problem Packs / Issue #2108] Security + contract assertions for the reusable
 * external Pack CI workflow (`.github/workflows/problem-pack-ci.yml`).
 *
 * The workflow itself runs on GitHub Actions, but its supply-chain and contract
 * invariants are checked here so a regression (a write permission creeping in, a
 * tag-pinned action, a leaked secret, a renamed output) fails CI offline. These
 * are exactly the issue's required workflow-level tests:
 *   - read-only permissions;
 *   - no cloud-credential / secret references;
 *   - every third-party action reference is a full commit SHA;
 *   - the declared output names are stable;
 *   - `pull_request_target` is never used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "problem-pack-ci.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf-8");
const docsSource = fs.readFileSync(path.join(repoRoot, "docs", "external-pack-ci.md"), "utf-8");

interface ReusableWorkflow {
  readonly on?: {
    readonly workflow_call?: {
      readonly inputs?: Record<string, unknown>;
      readonly outputs?: Record<string, unknown>;
    };
  };
  readonly permissions?: Record<string, string> | string;
  readonly jobs?: Record<
    string,
    { readonly steps?: Array<Record<string, unknown>>; readonly outputs?: Record<string, string> }
  >;
}

const workflow = parse(workflowSource) as ReusableWorkflow;

/** Collect every `uses:` action reference across all jobs/steps. */
function actionReferences(wf: ReusableWorkflow): string[] {
  const refs: string[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const uses = step.uses;
      if (typeof uses === "string") refs.push(uses);
    }
  }
  return refs;
}

describe("problem-pack-ci reusable workflow: trigger contract", () => {
  it("should be a reusable workflow triggered by workflow_call", () => {
    expect(workflow.on?.workflow_call).toBeDefined();
  });

  it("should never use pull_request_target", () => {
    // String scan defends against any nesting the typed view would miss.
    expect(workflowSource).not.toContain("pull_request_target");
  });

  it("should declare the documented workflow_call inputs", () => {
    const inputs = workflow.on?.workflow_call?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(
      ["core-version", "pack-directory", "run-local-tests", "upload-report"].sort(),
    );
  });
});

describe("problem-pack-ci reusable workflow: least privilege", () => {
  it("should grant read-only permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("should not request any write permission scope", () => {
    const permissions = workflow.permissions;
    if (typeof permissions === "object" && permissions !== null) {
      for (const scope of Object.values(permissions)) {
        expect(scope).not.toBe("write");
      }
    }
  });
});

describe("problem-pack-ci reusable workflow: no cloud credentials", () => {
  it("should not reference any AWS / cloud credential or secret", () => {
    const forbidden = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "aws-actions/configure-aws-credentials",
      "role-to-assume",
      "secrets.",
    ];
    for (const needle of forbidden) {
      expect(workflowSource).not.toContain(needle);
    }
  });

  it("should not configure any cloud provider login action", () => {
    for (const ref of actionReferences(workflow)) {
      expect(ref).not.toContain("aws-actions/");
      expect(ref).not.toContain("google-github-actions/");
      expect(ref).not.toContain("azure/login");
    }
  });
});

describe("problem-pack-ci reusable workflow: pinned third-party actions", () => {
  it("should pin every action reference to a full 40-hex commit SHA", () => {
    const refs = actionReferences(workflow);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const pin = ref.split("@")[1];
      expect(pin, `action '${ref}' must be SHA-pinned`).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("problem-pack-ci reusable workflow: stable outputs", () => {
  it("should declare exactly the contracted output names", () => {
    const outputs = workflow.on?.workflow_call?.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual(
      ["content-digest", "pack-id", "pack-version", "result", "validation-report-path"].sort(),
    );
  });

  it("should wire each workflow output from the validate-pack job output", () => {
    const outputs = (workflow.on?.workflow_call?.outputs ?? {}) as Record<
      string,
      { value?: string }
    >;
    for (const [name, spec] of Object.entries(outputs)) {
      expect(spec.value, `output '${name}' must read from the job`).toContain(
        "jobs.validate-pack.outputs.",
      );
    }
  });

  it("should expose the matching job-level outputs from the report step", () => {
    const job = workflow.jobs?.["validate-pack"];
    expect(job).toBeDefined();
    const jobOutputs = job?.outputs ?? {};
    expect(Object.keys(jobOutputs).sort()).toEqual(
      ["content-digest", "pack-id", "pack-version", "result", "validation-report-path"].sort(),
    );
    for (const value of Object.values(jobOutputs)) {
      expect(value).toContain("steps.report.outputs.");
    }
  });
});

describe("problem-pack-ci reusable workflow: docs example", () => {
  it("should document the reusable workflow path the external example calls", () => {
    expect(docsSource).toContain(
      "susumutomita/TenkaCloud/.github/workflows/problem-pack-ci.yml@v1",
    );
  });

  it("should document every workflow_call input the workflow declares", () => {
    const inputs = Object.keys(workflow.on?.workflow_call?.inputs ?? {});
    for (const input of inputs) {
      expect(docsSource, `docs must mention input '${input}'`).toContain(input);
    }
  });

  it("should document every workflow_call output the workflow declares", () => {
    const outputs = Object.keys(workflow.on?.workflow_call?.outputs ?? {});
    for (const output of outputs) {
      expect(docsSource, `docs must mention output '${output}'`).toContain(output);
    }
  });

  it("should document the published CLI command the workflow runs", () => {
    expect(docsSource).toContain("tenkacloud-pack-report");
    expect(docsSource).toContain("@tenkacloud/problem-sdk");
  });
});

describe("problem-pack-ci reusable workflow: offline pack execution", () => {
  it("should run only the published SDK report CLI, not a pack-supplied script", () => {
    expect(workflowSource).toContain("@tenkacloud/problem-sdk");
    expect(workflowSource).toContain("tenkacloud-pack-report");
    // The pack is checked out without persisting credentials.
    expect(workflowSource).toContain("persist-credentials: false");
  });

  it("should keep lifecycle scripts disabled during install", () => {
    expect(workflowSource).toContain('npm_config_ignore_scripts: "true"');
  });

  it("should not upload pack source files, only the report when requested", () => {
    const job = workflow.jobs?.["validate-pack"];
    const uploadStep = (job?.steps ?? []).find(
      (step) => typeof step.uses === "string" && step.uses.includes("upload-artifact"),
    );
    expect(uploadStep).toBeDefined();
    const withBlock = uploadStep?.with as { path?: string } | undefined;
    // The uploaded path is the report file, never the pack directory.
    expect(withBlock?.path).toContain("validation-report-path");
  });
});
