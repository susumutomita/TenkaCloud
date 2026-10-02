import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, BootstraplessSynthesizer, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertCurrentLauncherConfiguration } from "../../../scripts/cloud-hosting/launcher-contract.js";

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-launcher-"));
const templateFile = resolve(import.meta.dirname, "../../templates/cloud-pipeline.yaml");
const app = new App({ outdir: join(directory, "cdk.out") });
const stack = new Stack(app, "CloudLauncher", { synthesizer: new BootstraplessSynthesizer() });
new CfnInclude(stack, "Launcher", { templateFile });
const template = Template.fromStack(stack);
const source = z
  .object({ Properties: z.object({ Source: z.object({ BuildSpec: z.string() }) }) })
  .parse(template.findResources("AWS::CodeBuild::Project").CodeBuildProject);
const buildSpec = source.Properties.Source.BuildSpec;
afterAll(() => rmSync(directory, { recursive: true, force: true }));

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
function action(actionName: string, exitCode = 0, sourceContract = "historical-949a40a9") {
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
      SOURCE_CONTRACT: sourceContract,
      ENVIRONMENT: "staging",
      CALL_LOG: calls,
      MAKE_EXIT: String(exitCode),
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

describe("one complete current launcher with explicit historical-source compatibility; no AWS execution", () => {
  it("defaults to the current source contract and keeps initial IAM setup out of its build role", () => {
    const parsed = template.toJSON();
    template.hasParameter("SourceContract", {
      Default: "current-cloud-v1",
      AllowedValues: ["current-cloud-v1", "historical-949a40a9"],
    });
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].CurrentPlatformCommit).toMatch(
      /^[a-f0-9]{40}$/u,
    );
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].Classification).toBe(
      "candidate/unreleased",
    );
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].CatalogCommit).toBe(
      "915fe862fe09bf6b63bb96edcf0cb3deddd54d37",
    );
    expect(parsed.Mappings.SourceDefaults["historical-949a40a9"]).toEqual({
      CurrentPlatformCommit: "949a40a9ed9199331d928ad5cf9397dbb4ba3f81",
      CatalogCommit: "363a7c9b83969e20d63b74fd0410a354da5e202b",
      Classification: "historical/unverified",
    });
    const role = parsed.Resources.CodeBuildRole.Properties;
    expect(role.ManagedPolicyArns["Fn::If"][0]).toBe("UsesCurrentSources");
    expect(JSON.stringify(role.ManagedPolicyArns["Fn::If"][1])).toContain("-operator");
    const branches = role.Policies[0].PolicyDocument.Statement["Fn::If"];
    expect(branches[0]).toBe("UsesCurrentSources");
    expect(branches[1]).toEqual([
      {
        Sid: "LauncherLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: {
          "Fn::Sub": `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/tenkacloud/codebuild/lite-launcher-\${Environment}:*`,
        },
      },
    ]);
    expect(branches[2].map((entry: { Sid: string }) => entry.Sid)).toEqual([
      "DeployServices",
      "SsmParameters",
      "KmsForBootstrapAndAssets",
      "AssumeCdkRoles",
      "Identity",
    ]);
    template.resourceCountIs("AWS::CodeBuild::Project", 1);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });
  it("preserves historical parameter IDs and exposes compatibility without silently using ignored options", () => {
    const parsed = z
      .object({ Parameters: z.record(z.record(z.unknown())) })
      .parse(template.toJSON());
    expect(Object.keys(parsed.Parameters).sort()).toEqual(
      [
        "SourceContract",
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
    template.hasParameter("Action", { AllowedValues: ["deploy", "destroy", "destroy-all"] });
    template.hasParameter("RetainDataTables", {
      Default: "auto",
      AllowedValues: ["auto", "false", "true"],
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
  it("preserves source verification and historical bootstrap while requiring current source compatibility", () => {
    expect(buildSpec).toContain("rev-parse --verify 'FETCH_HEAD^{commit}'");
    expect(buildSpec).toContain("refusing to fall back to another ref");
    expect(buildSpec).toContain(
      `checkout_repo_ref "\${PROBLEMS_REPO_URL}" "\${PROBLEMS_REPO_REF}" repo/problems catalog`,
    );
    expect(buildSpec).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(buildSpec).toContain(`cdk bootstrap "aws://\${AWS_ACCOUNT_ID}/\${AWS_REGION}"`);
    for (const status of ["development/unreleased", "custom/unverified"])
      expect(buildSpec).toContain(status);
    expect(buildSpec).toContain(`release_classification="\${DEFAULT_CLASSIFICATION}"`);
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

describe("current launcher/source contract", () => {
  it.each(["deploy", "destroy"])(
    "uses the current %s entrypoint without legacy bootstrap or cleanup",
    (command) => {
      const result = action(command, 0, "current-cloud-v1");
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toBe(
        `${command} ENV=staging${command === "destroy" ? " CLOUD_ARGS=--yes" : ""}|confirm=unset\n`,
      );
      expect(result.stdout).not.toContain("TC{LITE-CLEANUP-COMPLETE}");
    },
  );
  it.each(["deploy", "destroy"])("preserves current %s failures", (command) => {
    expect(action(command, 17, "current-cloud-v1").status).toBe(17);
  });
  it("rejects destructive legacy cleanup and unknown source contracts before make", () => {
    expect(action("destroy-all", 0, "current-cloud-v1").calls).toBe("");
    expect(action("destroy-all", 0, "current-cloud-v1").status).toBe(2);
    expect(action("deploy", 0, "unknown").calls).toBe("");
  });
  it("maps the saved organizer/environment to the current CLI and verifies the source protocol", () => {
    expect(buildSpec).toContain(`export TENKACLOUD_ADMIN_EMAIL="\${TENANT_ADMIN_EMAIL}"`);
    expect(buildSpec).toContain(`export CDK_PARAM_ENVIRONMENT="\${ENVIRONMENT}"`);
    expect(buildSpec).toContain("does not implement current-cloud-v1");
    expect(buildSpec).toContain("bun scripts/cloud-hosting/launcher-check.ts || exit 1");
    expect(buildSpec).toContain(
      `if [ "\${RETAIN_DATA_TABLES}" = "auto" ]; then export RETAIN_DATA_TABLES=false; fi`,
    );
    expect(buildSpec).toContain(`if [ "\${CODEBUILD_BUILD_SUCCEEDING}" != "1" ]`);
  });
  it("accepts supported current defaults and refuses every legacy-only option", () => {
    const env = { SOURCE_CONTRACT: "current-cloud-v1" };
    expect(() => assertCurrentLauncherConfiguration(env)).not.toThrow();
    for (const override of [
      { SOURCE_CONTRACT: "historical-949a40a9" },
      { ACTION: "destroy-all" },
      { CONTROL_DATA_BACKEND: "turso" },
      { TURSO_DATABASE_URL: "libsql://test" },
      { TURSO_AUTH_TOKEN_PARAMETER_NAME: "/test" },
      { DEPLOY_EXTERNAL_ID: "legacy-external-id" },
      { DYNAMO_READ_CAPACITY: "2" },
      { DYNAMO_WRITE_CAPACITY: "2" },
      { RETAIN_DATA_TABLES: "false" },
    ])
      expect(() => assertCurrentLauncherConfiguration({ ...env, ...override })).toThrow();
  });
});
