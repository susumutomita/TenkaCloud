import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, BootstraplessSynthesizer, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
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

const phases = z
  .object({ phases: z.record(z.string(), z.object({ commands: z.array(z.string()) })) })
  .parse(parse(buildSpec)).phases;

/** Execute the real buildspec shell with deployment commands replaced by local fixtures. */
function runPhases(names: string[], env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(directory, "action-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "repo"));
  const calls = join(root, "calls");
  const configuration = join(root, "configuration");
  writeFileSync(calls, "");
  writeFileSync(configuration, "");
  const make = join(bin, "make");
  writeFileSync(
    make,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
printf '%s\\n' "$TENKACLOUD_ADMIN_EMAIL" "$CDK_PARAM_ENVIRONMENT" "$AWS_REGION" "$CDK_PARAM_RETAIN_DATA_TABLES" "$CDK_PARAM_CONTROL_DATA_BACKEND" "$CDK_PARAM_TURSO_DATABASE_URL" "$CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME" > "$CONFIG_LOG"
exit "$MAKE_EXIT"
`,
  );
  chmodSync(make, 0o700);
  const bun = join(bin, "bun");
  writeFileSync(
    bun,
    `#!/bin/sh
[ "$*" = "scripts/cloud-hosting/launcher-check.ts" ] || exit 99
exit "$CHECK_EXIT"
`,
  );
  chmodSync(bun, 0o700);
  const script = names
    .map((name) => {
      const phase = phases[name];
      if (!phase) throw new Error(`Missing buildspec phase: ${name}`);
      return phase.commands.join("\n");
    })
    .join("\n");
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: bin,
      ACTION: "deploy",
      ENVIRONMENT: "staging",
      CODEBUILD_SRC_DIR: root,
      CODEBUILD_BUILD_SUCCEEDING: "1",
      AWS_DEFAULT_REGION: "ap-northeast-1",
      TENANT_ADMIN_EMAIL: "organizer@example.com",
      RETAIN_DATA_TABLES: "false",
      CONTROL_DATA_BACKEND: "dynamodb",
      CALL_LOG: calls,
      CONFIG_LOG: configuration,
      MAKE_EXIT: "0",
      CHECK_EXIT: "0",
      ...env,
    },
  });
  return {
    ...result,
    calls: readFileSync(calls, "utf8"),
    configuration: readFileSync(configuration, "utf8"),
  };
}

describe("current cloud launcher; no AWS execution", () => {
  it("keeps the current launcher manifest and template source pins aligned", () => {
    const manifest = z
      .object({
        $comment: z.string(),
        sourceContract: z.literal("current-cloud-v1"),
        classification: z.literal("candidate/unreleased"),
        platformCommit: z.string().regex(/^[a-f0-9]{40}$/u),
        catalogCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      })
      .strict()
      .parse(
        JSON.parse(
          readFileSync(
            resolve(import.meta.dirname, "../../../release/launcher-defaults.json"),
            "utf8",
          ),
        ),
      );
    expect(template.toJSON().Mappings.SourceDefaults[manifest.sourceContract]).toEqual({
      CurrentPlatformCommit: manifest.platformCommit,
      CatalogCommit: manifest.catalogCommit,
      Classification: manifest.classification,
    });
  });
  it("pins current sources and discloses the preserved privileged launcher caller role", () => {
    const parsed = template.toJSON();
    expect(Object.keys(parsed.Mappings.SourceDefaults)).toEqual(["current-cloud-v1"]);
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].CurrentPlatformCommit).toMatch(
      /^[a-f0-9]{40}$/u,
    );
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].Classification).toBe(
      "candidate/unreleased",
    );
    expect(parsed.Mappings.SourceDefaults["current-cloud-v1"].CatalogCommit).toBe(
      "4bb3a116c545fc46ed6a39ffcc5117fb914947f4",
    );
    const role = parsed.Resources.CodeBuildRole.Properties;
    expect(role.ManagedPolicyArns).toBeUndefined();
    const statements = role.Policies[0].PolicyDocument.Statement;
    expect(statements.slice(0, 5).map((entry: { Sid: string }) => entry.Sid)).toEqual([
      "DeployServices",
      "SsmParameters",
      "KmsForBootstrapAndAssets",
      "AssumeCdkRoles",
      "Identity",
    ]);
    // Retain the reviewed caller policy. Current bootstrap
    // authority is explicit rather than depending on a generated custom operator policy.
    expect(statements[0]).toEqual({
      Sid: "DeployServices",
      Effect: "Allow",
      Action: [
        "cloudformation:*",
        "iam:*",
        "lambda:*",
        "apigateway:*",
        "cognito-idp:*",
        "cognito-identity:*",
        "dynamodb:*",
        "s3:*",
        "cloudfront:*",
        "states:*",
        "events:*",
        "sns:*",
        "sqs:*",
        "ecr:*",
        "codebuild:*",
        "logs:*",
      ],
      Resource: "*",
    });
    expect(statements[3]).toEqual({
      Sid: "AssumeCdkRoles",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: [{ "Fn::Sub": `arn:aws:iam::\${AWS::AccountId}:role/cdk-*` }],
    });
    expect(JSON.stringify(role)).not.toContain("policy/tenkacloud/cloud-hosting/");
    expect(parsed.Description).toContain("Standard bootstrap defaults to AdministratorAccess");
    template.resourceCountIs("AWS::CodeBuild::Project", 1);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });
  it("offers only supported current configuration with DynamoDB default and optional Turso", () => {
    const parsed = z
      .object({ Parameters: z.record(z.string(), z.record(z.string(), z.unknown())) })
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
        "ControlDataBackend",
        "TursoDatabaseUrl",
        "TursoAuthTokenParameterName",
        "RetainDataTables",
        "BunVersion",
        "CodeBuildTimeoutMinutes",
      ].sort(),
    );
    template.hasParameter("Action", { AllowedValues: ["deploy", "destroy", "destroy-all"] });
    template.hasParameter("RetainDataTables", {
      Default: "false",
      AllowedValues: ["false", "true"],
    });
    template.hasParameter("ControlDataBackend", {
      Default: "dynamodb",
      AllowedValues: ["dynamodb", "turso"],
    });
    for (const obsolete of [
      "SourceContract",
      "DeployExternalId",
      "DynamoReadCapacity",
      "DynamoWriteCapacity",
      "ReleaseManifestVersion",
    ])
      expect(JSON.stringify(template.toJSON())).not.toContain(obsolete);
  });
  it("allows cleanup to read only the configured Turso token when Turso is selected", () => {
    const parsed = template.toJSON();
    expect(parsed.Conditions.UsesTurso).toEqual({
      "Fn::Equals": [{ Ref: "ControlDataBackend" }, "turso"],
    });
    expect(parsed.Conditions.UsesTursoAuthToken).toEqual({
      "Fn::And": [
        { Condition: "UsesTurso" },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "TursoAuthTokenParameterName" }, ""] }] },
      ],
    });
    const statements =
      parsed.Resources.CodeBuildRole.Properties.Policies[0].PolicyDocument.Statement;
    expect(statements).toHaveLength(6);
    expect(statements[5]).toEqual({
      "Fn::If": [
        "UsesTursoAuthToken",
        {
          Sid: "TursoTokenForCleanup",
          Effect: "Allow",
          Action: ["ssm:GetParameter"],
          Resource: {
            "Fn::Sub": `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter\${TursoAuthTokenParameterName}`,
          },
        },
        { Ref: "AWS::NoValue" },
      ],
    });
    const parameter = z
      .object({ AllowedPattern: z.string() })
      .parse(parsed.Parameters.TursoAuthTokenParameterName);
    const pattern = new RegExp(parameter.AllowedPattern, "u");
    for (const name of ["", "/TenkaCloud/staging/turso/token", "/other-project/token.v2"])
      expect(pattern.test(name)).toBe(true);
    for (const name of ["/*", "/TenkaCloud/*", "/token?", "relative/name", "/", "/a//b"])
      expect(pattern.test(name)).toBe(false);
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
    expect(buildSpec).not.toContain("TC{LITE-CLEANUP-COMPLETE}");
  });
  it("verifies immutable source checkouts and requires current launcher compatibility", () => {
    expect(buildSpec).toContain("rev-parse --verify 'FETCH_HEAD^{commit}'");
    expect(buildSpec).toContain("refusing to fall back to another ref");
    expect(buildSpec).toContain(
      `checkout_repo_ref "\${PROBLEMS_REPO_URL}" "\${PROBLEMS_REPO_REF}" repo/problems catalog`,
    );
    expect(buildSpec).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(buildSpec).toContain("if [ ! -f repo/scripts/cloud-hosting/launcher-check.ts ]; then");
    expect(buildSpec).toContain("does not implement current-cloud-v1");
    expect(buildSpec).not.toContain("SOURCE_CONTRACT");
    for (const status of ["development/unreleased", "custom/unverified"])
      expect(buildSpec).toContain(status);
    expect(buildSpec).toContain(`release_classification="\${DEFAULT_CLASSIFICATION}"`);
  });
  it.each(["deploy", "destroy", "destroy-all"])(
    "uses plain deploy and retains explicit unattended deletion approval for %s",
    (command) => {
      const result = runPhases(["build"], { ACTION: command });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toBe(
        command === "deploy" ? "deploy ENV=staging\n" : `${command} ENV=staging CLOUD_ARGS=--yes\n`,
      );
      expect(result.stdout).not.toContain("TC{LITE-CLEANUP-COMPLETE}");
    },
  );
  it.each(["deploy", "destroy", "destroy-all"])("preserves %s failures", (command) => {
    const result = runPhases(["build", "post_build"], { ACTION: command, MAKE_EXIT: "17" });
    expect(result.status).toBe(17);
    expect(result.stdout).not.toContain("finished");
  });
  it("refuses an unknown action before invoking make", () => {
    const result = runPhases(["build"], { ACTION: "unexpected" });
    expect(result.status).toBe(2);
    expect(result.calls).toBe("");
  });
  it("never reports success from a failing CodeBuild run", () => {
    const result = runPhases(["post_build"], { CODEBUILD_BUILD_SUCCEEDING: "0" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Build failed");
    expect(result.stdout).not.toContain("finished");
  });
  it.each(["dynamodb", "turso"])("forwards %s configuration to the current CLI", (backend) => {
    const result = runPhases(["pre_build", "build"], {
      CONTROL_DATA_BACKEND: backend,
      TURSO_DATABASE_URL: backend === "turso" ? "libsql://cloud.example.com" : "",
      TURSO_AUTH_TOKEN_PARAMETER_NAME: backend === "turso" ? "/TenkaCloud/staging/turso/token" : "",
      RETAIN_DATA_TABLES: "true",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.configuration.split("\n")).toEqual([
      "organizer@example.com",
      "staging",
      "ap-northeast-1",
      "true",
      backend,
      backend === "turso" ? "libsql://cloud.example.com" : "",
      backend === "turso" ? "/TenkaCloud/staging/turso/token" : "",
      "",
    ]);
    expect(result.calls).toBe("deploy ENV=staging\n");
  });
  it("rejects launcher-check failure before deployment", () => {
    const result = runPhases(["pre_build", "build"], { CHECK_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toBe("");
    expect(result.configuration).toBe("");
  });
  it("maps the launcher backend parameters into the CodeBuild environment", () => {
    const project = z
      .object({
        Properties: z.object({
          Environment: z.object({ EnvironmentVariables: z.array(z.unknown()) }),
        }),
      })
      .parse(template.findResources("AWS::CodeBuild::Project").CodeBuildProject);
    expect(project.Properties.Environment.EnvironmentVariables).toEqual(
      expect.arrayContaining([
        { Name: "CONTROL_DATA_BACKEND", Value: { Ref: "ControlDataBackend" }, Type: "PLAINTEXT" },
        { Name: "TURSO_DATABASE_URL", Value: { Ref: "TursoDatabaseUrl" }, Type: "PLAINTEXT" },
        {
          Name: "TURSO_AUTH_TOKEN_PARAMETER_NAME",
          Value: { Ref: "TursoAuthTokenParameterName" },
          Type: "PLAINTEXT",
        },
      ]),
    );
  });
});

const tursoConfiguration = {
  CONTROL_DATA_BACKEND: "turso",
  TURSO_DATABASE_URL: "libsql://cloud.example.com",
  TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/staging/turso/token",
};

describe("current launcher configuration", () => {
  it.each([undefined, "", "  ", "dynamodb", " DynamoDB "])(
    "defaults to DynamoDB or normalizes the backend %s",
    (backend) => {
      expect(() =>
        assertCurrentLauncherConfiguration({ CONTROL_DATA_BACKEND: backend }),
      ).not.toThrow();
    },
  );
  it.each(["libsql://cloud.example.com", "https://cloud.example.com"])(
    "accepts current Turso hosting with %s",
    (url) => {
      expect(() =>
        assertCurrentLauncherConfiguration({
          ...tursoConfiguration,
          CONTROL_DATA_BACKEND: " Turso ",
          TURSO_DATABASE_URL: ` ${url} `,
        }),
      ).not.toThrow();
    },
  );
  it.each([
    { CONTROL_DATA_BACKEND: "unknown" },
    { TURSO_DATABASE_URL: "" },
    { TURSO_AUTH_TOKEN_PARAMETER_NAME: "" },
    { TURSO_DATABASE_URL: "file:/tmp/local.db" },
    { TURSO_DATABASE_URL: "https://user:secret@cloud.example.com" },
    { TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/*" },
    { TURSO_AUTH_TOKEN_PARAMETER_NAME: "unrooted-parameter" },
  ])("refuses invalid backend configuration %j", (override) => {
    expect(() =>
      assertCurrentLauncherConfiguration({ ...tursoConfiguration, ...override }),
    ).toThrow();
  });
  it.each(["deploy", "destroy", "destroy-all"])("accepts action %s", (command) => {
    expect(() => assertCurrentLauncherConfiguration({ ACTION: command })).not.toThrow();
  });
  it.each(["destroy", "destroy-all"])(
    "allows %s to use deployed ownership despite missing or corrupt desired database configuration",
    (command) => {
      for (const configuration of [
        { CONTROL_DATA_BACKEND: "turso" },
        { CONTROL_DATA_BACKEND: "unknown" },
        {
          CONTROL_DATA_BACKEND: "turso",
          TURSO_DATABASE_URL: "invalid-local-url",
          TURSO_AUTH_TOKEN_PARAMETER_NAME: "/*",
        },
      ])
        expect(() =>
          assertCurrentLauncherConfiguration({
            ...configuration,
            ACTION: command,
          }),
        ).not.toThrow();
      expect(() =>
        assertCurrentLauncherConfiguration({
          ACTION: command,
          RETAIN_DATA_TABLES: "invalid",
        }),
      ).toThrow("RetainDataTables");
    },
  );
  it.each([undefined, "false", "true"])("accepts retention %s", (retention) => {
    expect(() =>
      assertCurrentLauncherConfiguration({ RETAIN_DATA_TABLES: retention }),
    ).not.toThrow();
  });
  it.each([
    { ACTION: "unexpected" },
    { RETAIN_DATA_TABLES: "auto" },
    { RETAIN_DATA_TABLES: "invalid" },
  ])("refuses invalid action or retention %j", (override) => {
    expect(() => assertCurrentLauncherConfiguration(override)).toThrow();
  });
});
