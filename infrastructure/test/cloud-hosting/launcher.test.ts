import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, BootstraplessSynthesizer, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-launcher-"));
const templateFile = resolve(import.meta.dirname, "../../templates/cloud-pipeline.yaml");
const raw = readFileSync(templateFile, "utf8");
const app = new App({ outdir: join(directory, "cdk.out") });
const stack = new Stack(app, "CloudLauncher", { synthesizer: new BootstraplessSynthesizer() });
new CfnInclude(stack, "Launcher", { templateFile });
const template = Template.fromStack(stack);
const source = z
  .object({ Properties: z.object({ Source: z.object({ BuildSpec: z.string() }) }) })
  .parse(template.findResources("AWS::CodeBuild::Project").CodeBuildProject);
const buildSpec = source.Properties.Source.BuildSpec;
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function preservedSection(start: string, end: string): string {
  const section = raw.split(`\n${start}:\n`)[1]?.split(`\n${end}:\n`)[0];
  if (!section) throw new Error(`Missing ${start} section`);
  return section;
}
function buildActionScript(): string {
  const phase = buildSpec.split("\n  build:\n")[1]?.split("\n  post_build:\n")[0];
  const block = phase?.split("\n      - |\n")[1];
  if (!block) throw new Error("Missing preserved build action script");
  return block
    .split("\n")
    .map((line) => line.replace(/^ {8}/u, ""))
    .join("\n");
}
/** Only the preserved action selector runs, with make replaced by a synthetic executable. */
function action(actionName: string, exitCode = 0) {
  const root = mkdtempSync(join(directory, "action-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  const make = join(bin, "make");
  writeFileSync(
    make,
    `#!/bin/sh\nprintf "%s|confirm=%s\\n" "$*" "\${TENKACLOUD_LITE_DOWN_YES-unset}" >> "$CALL_LOG"\nexit "$MAKE_EXIT"\n`,
  );
  chmodSync(make, 0o700);
  const result = spawnSync("/bin/bash", ["-c", buildActionScript()], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: bin,
      ACTION: actionName,
      ENVIRONMENT: "staging",
      CALL_LOG: calls,
      MAKE_EXIT: String(exitCode),
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

describe("complete cloud pipeline rename compatibility; no AWS execution", () => {
  it("changes the displayed mode without changing any historical resource or build instruction", () => {
    // Original resource bytes and condition expressions are pinned to 825415fc; comments may clarify provenance.
    expect(
      createHash("sha256").update(preservedSection("Resources", "Outputs")).digest("hex"),
    ).toBe("22277ff4a9f2602b338fc519bd93f98c5a10315f91c34e3594e8a14f239caa03");
    expect(
      createHash("sha256")
        .update(preservedSection("Conditions", "Resources").replace(/^ *#.*\n/gmu, ""))
        .digest("hex"),
    ).toBe("2c05063686a45b0bc6cad504fe8b79c2f0ec4ad03bc37a1825c1799413b66b56");
    const parsed = z.object({ Description: z.string() }).parse(template.toJSON());
    expect(parsed.Description).toContain("cloud hosting");
    expect(parsed.Description).toContain("fixed historical platform/catalog refs");
    expect(parsed.Description).not.toContain("Lite mode");
    template.resourceCountIs("AWS::CodeBuild::Project", 1);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });
  it("keeps all parameter IDs, pinned source refs and deploy/destroy/retention options", () => {
    const parsed = z
      .object({ Parameters: z.record(z.record(z.unknown())) })
      .parse(template.toJSON());
    expect(Object.keys(parsed.Parameters).sort()).toEqual(
      [
        "Environment",
        "Action",
        "TenantAdminEmail",
        "RepoUrl",
        "RepoRef",
        "ProblemsRepoUrl",
        "ProblemsRepoRef",
        "DeployExternalId",
        "ControlDataBackend",
        "TursoDatabaseUrl",
        "TursoAuthTokenParameterName",
        "DynamoReadCapacity",
        "DynamoWriteCapacity",
        "RetainDataTables",
        "BunVersion",
        "CodeBuildTimeoutMinutes",
      ].sort(),
    );
    template.hasParameter("RepoRef", { Default: "949a40a9ed9199331d928ad5cf9397dbb4ba3f81" });
    template.hasParameter("ProblemsRepoRef", {
      Default: "363a7c9b83969e20d63b74fd0410a354da5e202b",
    });
    template.hasParameter("Action", { AllowedValues: ["deploy", "destroy", "destroy-all"] });
    template.hasParameter("RetainDataTables", {
      Default: "false",
      AllowedValues: ["false", "true"],
    });
    template.hasParameter("ControlDataBackend", {
      Default: "dynamodb",
      AllowedValues: ["dynamodb", "turso"],
    });
    template.hasParameter("DeployExternalId", { NoEcho: true });
  });
  it("keeps physical identities, output links and existing onboarding checkpoint values", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: { "Fn::Sub": `tenkacloud-lite-\${Environment}` },
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: { "Fn::Sub": `tenkacloud-lite-\${Environment}-codebuild-role` },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: { "Fn::Sub": `/tenkacloud/codebuild/lite-launcher-\${Environment}` },
    });
    template.hasOutput("OnboardingDrillCheckpoint", { Value: "TC{LITE-LAUNCHER-READY}" });
    template.hasOutput("StartBuildConsoleUrl", {
      Value: {
        "Fn::Sub": `https://\${AWS::Region}.console.aws.amazon.com/codesuite/codebuild/projects/tenkacloud-lite-\${Environment}?region=\${AWS::Region}`,
      },
    });
    expect(buildSpec).toContain("TC{LITE-CLEANUP-COMPLETE}");
  });
  it("preserves source verification, installation, automatic bootstrap and explicit release classification", () => {
    expect(buildSpec).toContain("rev-parse --verify 'FETCH_HEAD^{commit}'");
    expect(buildSpec).toContain("refusing to fall back to another ref");
    expect(buildSpec).toContain(
      `checkout_repo_ref "\${PROBLEMS_REPO_URL}" "\${PROBLEMS_REPO_REF}" repo/problems catalog`,
    );
    expect(buildSpec).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(buildSpec).toContain(`cdk bootstrap "aws://\${AWS_ACCOUNT_ID}/\${AWS_REGION}"`);
    for (const status of ["candidate/unverified", "development/unreleased", "custom/unverified"])
      expect(buildSpec).toContain(status);
  });
  it.each(["deploy", "destroy", "destroy-all"])(
    "keeps the %s action and its confirmation/checkpoint contract",
    (command) => {
      const result = action(command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toBe(
        `${command} ENV=staging|confirm=${command === "deploy" ? "unset" : "1"}\n`,
      );
      if (command === "destroy-all")
        expect(result.stdout).toContain("Cleanup checkpoint: TC{LITE-CLEANUP-COMPLETE}");
      else expect(result.stdout).not.toContain("Cleanup checkpoint: TC{LITE-CLEANUP-COMPLETE}");
    },
  );
  it.each(["deploy", "destroy", "destroy-all"])(
    "does not report cleanup success after %s fails",
    (command) => {
      const result = action(command, 17);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Cleanup checkpoint: TC{LITE-CLEANUP-COMPLETE}");
    },
  );
  it("refuses an unknown action before invoking make", () => {
    const result = action("unexpected");
    expect(result.status).toBe(2);
    expect(result.calls).toBe("");
  });
});
