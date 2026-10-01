import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApplicationStack } from "../../lib/cloud-hosting/application-stack.js";
import { projectBootstrap } from "../../lib/cloud-hosting/bootstrap.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import { cloudStackTags } from "../../lib/cloud-hosting/stack-names.js";
import { projectSynthesizer } from "../../lib/cloud-hosting/synthesizer.js";

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
    expect(configs).toContainEqual(
      expect.objectContaining({ eventLimits: { maxTeams: 49, maxProblems: 50 } }),
    );
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
      ["POST", "DELETE"].includes(method.Properties.HttpMethod),
    );
    expect(writes).toHaveLength(3);
    expect(
      writes.every((method) => method.Properties.AuthorizationType === "COGNITO_USER_POOLS"),
    ).toBe(true);
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
  it("has no tenant billing tiers, broad DDB permissions, or exercise role assumption", () => {
    application.resourceCountIs("AWS::ApiGateway::UsagePlan", 0);
    application.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
    const text = JSON.stringify(application.toJSON());
    expect(text).not.toContain("AdministratorAccess");
    expect(text).not.toContain("dynamodb:*");
    const identityPolicies = JSON.stringify(application.findResources("AWS::IAM::Policy"));
    expect(identityPolicies).not.toContain("sts:AssumeRole");
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
