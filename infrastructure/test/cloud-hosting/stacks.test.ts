import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CloudApplicationStack } from "../../lib/cloud-hosting/application-stack.js";
import { projectBootstrap } from "../../lib/cloud-hosting/bootstrap.js";
import {
  competitorAssumeRolePolicy,
  installationCompetitorConfig,
} from "../../lib/cloud-hosting/competitor-accounts.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import { cloudExecutionArtifacts } from "../../lib/cloud-hosting/execution-artifacts.js";
import { CloudHosting } from "../../lib/cloud-hosting/hosting.js";
import { cloudStackTags } from "../../lib/cloud-hosting/stack-names.js";
import { projectSynthesizer } from "../../lib/cloud-hosting/synthesizer.js";
import { CLOUD_EVENT_LIMITS } from "../../lib/problem-deploy/control-data/domain/events.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-synth-"));
let data: Template;
let application: Template;
let stackTags: Record<string, string>[];
beforeAll(() => {
  const assets = join(directory, "assets");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "index.html"),
    "<!doctype html><title>Synthetic static asset for CDK contract test</title>",
  );
  const app = new App({ outdir: join(directory, "cdk.out") });
  const env = { account: "123456789012", region: "us-east-1" };
  const backend = new CloudDataStack(app, "CloudBackend", {
    env,
    tags: cloudStackTags("test"),
    synthesizer: projectSynthesizer("test"),
    participantAssets: assets,
  });
  const stack = new CloudApplicationStack(app, "CloudApplication", {
    env,
    tags: cloudStackTags("test"),
    environment: "test",
    synthesizer: projectSynthesizer("test"),
    backend,
    consoleAssets: assets,
    repositoryRoot: resolve(import.meta.dirname, "../../.."),
  });
  // This also detects cross-stack dependency cycles. It performs no context lookup or AWS calls.
  stackTags = app.synth().stacks.map((artifact) => artifact.tags);
  data = Template.fromStack(backend);
  application = Template.fromStack(stack);
}, 60_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("cloud CDK synth-only security and frontend wiring", () => {
  it("emits project and environment ownership tags on both CloudFormation stack artifacts", () => {
    expect(stackTags).toEqual([cloudStackTags("test"), cloudStackTags("test")]);
  });
  it("uses the project qualifier rather than the default/shared CDK toolkit", () => {
    const templates = JSON.stringify([data.toJSON(), application.toJSON()]);
    expect(templates).toContain(projectBootstrap("test").qualifier);
    expect(templates).not.toContain("hnb659fds");
  });
  it("publishes authoritative creation limits in the actual organizer runtime-config asset", () => {
    const outdir = join(directory, "cdk.out");
    const configs = readdirSync(outdir)
      .map((name) => join(outdir, name, "runtime-config.json"))
      .filter(existsSync)
      .map(
        (path) =>
          JSON.parse(
            readFileSync(path, "utf8").replace(/<<marker:[^>]+>>/gu, '"SYNTHESIZED_TOKEN"'),
          ) as unknown,
      );
    expect(configs).toContainEqual(expect.objectContaining({ eventLimits: CLOUD_EVENT_LIMITS }));
  });
  it("retains all event/team/deployment data by default and does not TTL-delete history", () => {
    data.resourceCountIs("AWS::DynamoDB::Table", 3);
    const tables = data.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      expect(table.DeletionPolicy).toBe("Retain");
      expect(table.UpdateReplacePolicy).toBe("Retain");
      expect(table.Properties.DeletionProtectionEnabled).toBe(true);
      expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
      expect(table.Properties.KeySchema).toEqual([
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ]);
    }
  });
  it("uses signature-validating REST Cognito ID-token authorization with audience pinning", () => {
    application.hasResourceProperties("AWS::ApiGateway::Authorizer", {
      Type: "COGNITO_USER_POOLS",
      IdentitySource: "method.request.header.Authorization",
      IdentityValidationExpression: { "Fn::Join": ["", ["^", Match.anyValue(), "$"]] },
    });
    const methods = Object.values(application.findResources("AWS::ApiGateway::Method"));
    const writes = methods.filter((method) =>
      ["POST", "DELETE", "PATCH"].includes(method.Properties.HttpMethod),
    );
    expect(writes).toHaveLength(14);
    const flagId = Object.entries(application.findResources("AWS::ApiGateway::Resource")).find(
      ([, resource]) => resource.Properties.PathPart === "submit-flag",
    )?.[0];
    expect(flagId).toBeDefined();
    const publicWrites = writes.filter(
      (method) => method.Properties.AuthorizationType !== "COGNITO_USER_POOLS",
    );
    expect(publicWrites).toHaveLength(1);
    expect(publicWrites[0]?.Properties).toMatchObject({
      HttpMethod: "POST",
      ResourceId: { Ref: flagId },
      AuthorizationType: "NONE",
    });
    application.resourceCountIs("AWS::Lambda::Url", 0);
    application.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          COGNITO_ISSUER: Match.anyValue(),
          COGNITO_CLIENT_ID: Match.anyValue(),
          ALLOWED_ORIGINS: Match.anyValue(),
        }),
      },
    });
  });
  it("prevents self-signup and self-assignment of organizer privilege, with required TOTP MFA", () => {
    application.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
    });
    application.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      GenerateSecret: false,
      ReadAttributes: Match.arrayWith(["custom:userRole"]),
      WriteAttributes: ["email"],
    });
    const text = JSON.stringify(application.toJSON());
    expect(text).not.toContain("DEFAULT_USER_ROLE");
    expect(text).not.toContain("DEFAULT_TENANT_ID");
  });
  it("keeps the registry runner free of tenant billing, broad DDB grants, or platform AdministratorAccess", () => {
    application.resourceCountIs("AWS::ApiGateway::UsagePlan", 0);
    application.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
    const text = JSON.stringify(application.toJSON());
    expect(text).not.toContain("AdministratorAccess");
    expect(text).not.toContain("dynamodb:*");
    const identityPolicies = JSON.stringify(application.findResources("AWS::IAM::Policy"));
    expect(identityPolicies).toContain("sts:AssumeRole");
    expect(identityPolicies).toContain("aws:ResourceTag/TenkaCloud:Installation");
    expect(identityPolicies).toContain(
      installationCompetitorConfig("123456789012", "us-east-1", "test").roleName,
    );
    expect(text).not.toContain("TURSO");
    expect(text).not.toContain("SBT");
  });
  it("limits generated invalidation permissions to this installation's distributions", () => {
    for (const template of [data, application]) {
      const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as {
            Action: string | string[];
            Resource: unknown;
          }[],
      );
      const invalidations = statements.filter((statement) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          "cloudfront:CreateInvalidation",
        ),
      );
      expect(invalidations.length).toBeGreaterThan(0);
      for (const statement of invalidations) {
        expect(statement.Resource).not.toBe("*");
        expect(JSON.stringify(statement.Resource)).not.toContain("distribution/*");
      }
    }
  });
  it("gives the API its own scoped logging role without broad managed execution policies", () => {
    const entry = Object.entries(application.findResources("AWS::IAM::Role")).find(([id]) =>
      id.startsWith("ApiRole"),
    );
    expect(entry).toBeDefined();
    expect(entry?.[1].Properties.ManagedPolicyArns).toBeUndefined();
  });
  it("keeps the historical CLI access outputs and private S3 origins", () => {
    expect(application.toJSON().Outputs).toBeDefined();
    application.hasOutput("ApplicationAdminConsoleUrl", { Value: Match.anyValue() });
    application.hasOutput("OrganizerUserPoolId", { Value: Match.anyValue() });
    data.hasOutput("ParticipantPortalApiUrl", { Value: Match.anyValue() });
    for (const template of [data, application])
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
  });
});

function artifactFixture() {
  const base = mkdtempSync(join(directory, "artifact-boundary-"));
  const root = join(base, "repository");
  const folder = join(root, "problems/challenges/hello-world");
  mkdirSync(folder, { recursive: true });
  const metadata = JSON.stringify({
    id: "hello-world",
    cfnParameters: { NamePrefix: "synthetic" },
    scoring: { kind: "flag", points: 100, flagOutputKey: "ExpectedFlag", wrongAnswerPenalty: 5 },
  });
  writeFileSync(join(folder, "metadata.json"), metadata);
  writeFileSync(join(folder, "template.yaml"), "Resources: {} # synthetic artifact test");
  const stack = new Stack(new App({ outdir: join(base, "cdk.out") }), "ArtifactBoundary");
  return { base, root, folder, stack };
}

describe("direct synth execution artifact filesystem boundary", () => {
  it("accepts repository regular files and still creates content-addressed artifacts", () => {
    const f = artifactFixture();
    const result = cloudExecutionArtifacts(f.stack, f.root, []);
    expect(result.catalogKey).toMatch(/^catalogs\/[a-f0-9]{64}\.json$/u);
    expect(result.bindingsKey).toMatch(/^bindings\/[a-f0-9]{64}\.json$/u);
    Template.fromStack(f.stack).resourceCountIs("AWS::S3::Bucket", 1);
  });

  it.each([
    ["metadata.json", "internal"],
    ["metadata.json", "external"],
    ["template.yaml", "internal"],
    ["template.yaml", "external"],
  ])("rejects %s symlinks to %s files before any artifact content is read", (name, location) => {
    const f = artifactFixture();
    const file = join(f.folder, name);
    const target =
      location === "internal" ? join(f.root, "synthetic-target") : join(f.base, "outside-target");
    // Only synthetic bytes are ever placed outside the repository fixture.
    writeFileSync(target, "synthetic symlink target; must never be read");
    rmSync(file);
    symlinkSync(target, file);
    vi.mocked(readFileSync).mockClear();
    expect(() => cloudExecutionArtifacts(f.stack, f.root, [])).toThrow("symbolic links");
    expect(readFileSync).not.toHaveBeenCalled();
    expect(f.stack.node.tryFindChild("ExecutionArtifacts")).toBeUndefined();
  });

  it.each([
    ["problems", "internal"],
    ["problems", "external"],
    ["problems/challenges", "internal"],
    ["problems/challenges", "external"],
    ["problems/challenges/hello-world", "internal"],
    ["problems/challenges/hello-world", "external"],
  ])("rejects linked %s directory components targeting %s paths", (component, location) => {
    const f = artifactFixture();
    const original = join(f.root, component);
    const target =
      location === "internal"
        ? join(f.root, "synthetic-linked-directory")
        : join(f.base, "outside-directory");
    renameSync(original, target);
    symlinkSync(target, original, "dir");
    vi.mocked(readFileSync).mockClear();
    expect(() => cloudExecutionArtifacts(f.stack, f.root, [])).toThrow("symbolic links");
    expect(readFileSync).not.toHaveBeenCalled();
    expect(f.stack.node.tryFindChild("ExecutionArtifacts")).toBeUndefined();
  });

  it("rejects a symlink repository root without reading its otherwise valid contents", () => {
    const f = artifactFixture();
    const linkedRoot = join(f.base, "repository-link");
    symlinkSync(f.root, linkedRoot, "dir");
    vi.mocked(readFileSync).mockClear();
    expect(() => cloudExecutionArtifacts(f.stack, linkedRoot, [])).toThrow("symbolic links");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("accepts a synthetic OS-style ancestor alias above a regular repository root", () => {
    const f = artifactFixture();
    const alias = join(directory, "synthetic-ancestor-link");
    symlinkSync(f.base, alias, "dir");
    vi.mocked(readFileSync).mockClear();
    const result = cloudExecutionArtifacts(f.stack, join(alias, "repository"), []);
    expect(result.catalogKey).toMatch(/^catalogs\/[a-f0-9]{64}\.json$/u);
    expect(readFileSync).toHaveBeenCalledWith(
      join(realpathSync(f.folder), "metadata.json"),
      "utf8",
    );
    expect(readFileSync).toHaveBeenCalledWith(
      join(realpathSync(f.folder), "template.yaml"),
      "utf8",
    );
  });

  it.each(["metadata.json", "template.yaml"])("requires %s to be a regular file", (name) => {
    const f = artifactFixture();
    const file = join(f.folder, name);
    rmSync(file);
    mkdirSync(file);
    vi.mocked(readFileSync).mockClear();
    expect(() => cloudExecutionArtifacts(f.stack, f.root, [])).toThrow("regular files");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("requires every intermediate component to be a directory", () => {
    const f = artifactFixture();
    rmSync(join(f.root, "problems"), { recursive: true });
    writeFileSync(join(f.root, "problems"), "synthetic non-directory path component");
    vi.mocked(readFileSync).mockClear();
    expect(() => cloudExecutionArtifacts(f.stack, f.root, [])).toThrow("directory path components");
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe("hosted SPA asset boundary", () => {
  it("stages public files and .well-known while excluding root and nested .env files and .git", () => {
    const base = mkdtempSync(join(directory, "hosting-boundary-"));
    const assets = join(base, "assets");
    const outdir = join(base, "cdk.out");
    for (const folder of [
      ".well-known",
      ".git",
      "nested/.git",
      "worktree",
      "nested/.env-directory",
    ]) {
      mkdirSync(join(assets, folder), { recursive: true });
    }
    const publicFiles = ["index.html", ".well-known/security.txt", "nested/app.js"];
    const privateFiles = [
      ".env",
      ".env.local",
      ".env.production",
      ".git/config",
      "nested/.env",
      "nested/.env.local",
      "nested/.git/config",
      "worktree/.git",
      "nested/.env-directory/synthetic.txt",
    ];
    for (const name of publicFiles)
      writeFileSync(join(assets, name), `synthetic public content: ${name}`);
    for (const name of privateFiles)
      writeFileSync(join(assets, name), "synthetic excluded content, no real secrets");
    const app = new App({ outdir });
    const stack = new Stack(app, "HostingBoundary");
    const site = new CloudHosting(stack, "Site", assets);
    expect(site.bucket.stack).toBe(stack);
    app.synth();
    const staged = readdirSync(outdir)
      .map((name) => join(outdir, name))
      .filter((path) => existsSync(join(path, "index.html")));
    expect(staged).toHaveLength(1);
    for (const path of staged) {
      for (const name of publicFiles)
        expect(readFileSync(join(path, name), "utf8")).toBe(`synthetic public content: ${name}`);
      for (const name of privateFiles) expect(existsSync(join(path, name))).toBe(false);
      expect(
        readdirSync(path, { recursive: true, encoding: "utf8" }).some((name) =>
          /(^|[/\\])(?:\.env[^/\\]*|\.git)([/\\]|$)/u.test(name),
        ),
      ).toBe(false);
    }
  });
});

describe("existing competitor bootstrap and registry IAM source boundaries", () => {
  const config = installationCompetitorConfig("123456789012", "us-east-1", "test");
  it("publishes the current registry mode, digest, and existing modal configuration", () => {
    const outputs = application.toJSON().Outputs;
    expect(outputs.CloudRunnerEnabled.Value).toBe("true");
    expect(outputs.CloudInstallationControlVersion.Value).toBe("1");
    expect(outputs.CloudRunnerMode.Value).toBe("registry");
    expect(outputs.CloudLegacyBindingsDigest.Value).toMatch(/^[a-f0-9]{64}$/u);
    expect(outputs.CompetitorRoleName.Value).toBe(config.roleName);
    const configs = readdirSync(join(directory, "cdk.out"))
      .map((name) => join(directory, "cdk.out", name, "runtime-config.json"))
      .filter(existsSync)
      .map((path) => readFileSync(path, "utf8"));
    const runtime = configs.find((value) => value.includes("competitorRoleName"));
    expect(runtime).toContain(config.roleName);
    expect(runtime).toContain("competitorBootstrapTemplateUrl");
    expect(JSON.stringify(application.findResources("Custom::CDKBucketDeployment"))).toContain(
      ".s3.us-east-1.amazonaws.com/competitor-bootstrap.yaml",
    );
  });
  it("grants role assumption only for the installation's fixed role name and both immutable trust tags", () => {
    const statements = Object.values(application.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Action: string | string[];
          Effect: string;
          Resource: unknown;
          Condition?: unknown;
        }[],
    );
    const assumptions = statements.filter(
      (statement) =>
        JSON.stringify(statement.Action).includes("sts:AssumeRole") && statement.Effect === "Allow",
    );
    expect(assumptions).toHaveLength(4);
    for (const statement of assumptions)
      expect(statement).toMatchObject({
        Resource: `arn:aws:iam::*:role/${config.roleName}`,
        Condition: {
          Null: { "sts:ExternalId": "false" },
          StringEquals: {
            "aws:ResourceTag/TenkaCloud:Purpose": "competitor-deploy",
            "aws:ResourceTag/TenkaCloud:Installation": config.roleName,
          },
        },
      });
    const selfDenials = statements.filter(
      (statement) =>
        JSON.stringify(statement.Action).includes("sts:AssumeRole") && statement.Effect === "Deny",
    );
    expect(selfDenials).toHaveLength(4);
    for (const statement of selfDenials)
      expect(statement.Resource).toBe("arn:aws:iam::123456789012:role/*");
    const dispatcherReads = statements.filter((statement) =>
      JSON.stringify(statement.Condition ?? {}).includes('"dynamodb:LeadingKeys":["INSTALLATION"]'),
    );
    expect(dispatcherReads).toHaveLength(1);
    expect(dispatcherReads[0]?.Action).toBe("dynamodb:GetItem");
    expect(JSON.stringify(dispatcherReads[0]?.Resource)).not.toContain("*");
    const puts = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes("ssm:PutParameter"),
    );
    expect(puts).toEqual([
      {
        Action: "ssm:PutParameter",
        Effect: "Allow",
        Resource: config.externalIdParameterArn,
        Condition: { StringEquals: { "ssm:Overwrite": "false" } },
      },
    ]);
    expect(JSON.stringify(statements)).not.toContain("ssm:DeleteParameter");
  });
  it("rejects caller-chosen role or secret scope rather than trusting a matching role tag alone", () => {
    for (const roleName of [
      "Administrator",
      "TenkaCloud-*-deploy-Role",
      `TenkaCloud-${"f".repeat(24)}-deploy-Role`,
      `${config.roleName}/Other`,
    ])
      expect(() => competitorAssumeRolePolicy({ ...config, roleName })).toThrow();
    expect(() =>
      competitorAssumeRolePolicy({
        ...config,
        externalIdParameterArn: config.externalIdParameterArn.replace("/cloud/", "/other/"),
      }),
    ).toThrow();
    expect(() => installationCompetitorConfig("*", "us-east-1", "test")).toThrow();
    expect(() => installationCompetitorConfig("123456789012", "cn-north-1", "test")).toThrow();
    expect(() => installationCompetitorConfig("123456789012", "us-east-1", "../other")).toThrow();
    expect(installationCompetitorConfig("123456789012", "us-east-1", "other").roleName).not.toBe(
      config.roleName,
    );
  });
  it("reuses the three bootstrap parameters, exact account/ExternalId trust, and competitor-only AdministratorAccess exception", () => {
    const app = new App({ outdir: join(directory, "competitor-template-synth") });
    const stack = new Stack(app, "SyntheticCompetitor", {
      env: { account: "222222222222", region: "us-east-1" },
    });
    new CfnInclude(stack, "Template", {
      templateFile: resolve(import.meta.dirname, "../../../templates/competitor-bootstrap.yaml"),
      parameters: {
        TenkaCloudAccountId: "123456789012",
        ExternalId: "SYNTHETIC-EXTERNAL-ID-ONLY",
        RoleName: config.roleName,
      },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: config.roleName,
      ManagedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": "SYNTHETIC-EXTERNAL-ID-ONLY" } },
          }),
        ],
      },
      Tags: Match.arrayWith([
        { Key: "TenkaCloud:Installation", Value: config.roleName },
        { Key: "TenkaCloud:Purpose", Value: "competitor-deploy" },
      ]),
    });
    const text = JSON.stringify(template.toJSON());
    expect(text).toContain("123456789012");
    expect(text).not.toContain('"AWS":"*"');
    expect(JSON.stringify(application.toJSON())).not.toContain("AdministratorAccess");
  });
  it("makes only the known secret-free bootstrap object public, with no bucket listing", () => {
    const statements = Object.values(application.findResources("AWS::S3::BucketPolicy")).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Effect: string;
          Principal: unknown;
          Action: unknown;
          Resource: unknown;
        }[],
    );
    const allowed = statements.filter(
      (statement) =>
        statement.Effect === "Allow" && JSON.stringify(statement.Principal).includes('"*"'),
    );
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.Action).toBe("s3:GetObject");
    expect(JSON.stringify(allowed[0]?.Resource)).toContain("competitor-bootstrap.yaml");
    expect(JSON.stringify(allowed[0]?.Resource)).not.toContain("/*");
  });
});
