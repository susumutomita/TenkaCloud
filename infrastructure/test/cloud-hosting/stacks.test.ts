import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUD_COMPOSITION, composeCloudHosting } from "../../lib/cloud-hosting/compose.js";
import { cloudDeploymentTarget } from "../../lib/cloud-hosting/regions.js";

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-restored-synth-"));
const target = { ACCOUNT_ID: "123456789012", REGION: "us-east-1", CDK_PARAM_ENVIRONMENT: "test" };
const fixtures: {
  backend: Template;
  application: Template;
  tags: Record<string, string>[];
  names: string[];
  outdir: string;
}[] = [];
beforeAll(() => {
  for (const name of ["application-admin-console", "participant-portal"]) {
    const dist = resolve(import.meta.dirname, "../../../apps", name, "dist");
    if (!existsSync(dist)) {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), "<!doctype html><title>Synthesis fixture</title>");
    }
  }
  for (const profile of ["dynamodb", "turso", "retained", "lite-dynamodb", "lite-turso"]) {
    const app = new App({
      outdir: join(directory, profile),
      context: { "aws:cdk:bundling-stacks": [], "@aws-cdk/core:bootstrapQualifier": "custom123" },
    });
    const { backend, application } = composeCloudHosting(
      app,
      {
        ...target,
        ...(profile.startsWith("lite-") ? { TENKACLOUD_STACK_LAYOUT: "lite" } : {}),
        ...(profile === "retained" ? { CDK_PARAM_RETAIN_DATA_TABLES: "true" } : {}),
        ...(profile.endsWith("turso")
          ? {
              CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
              CDK_PARAM_TURSO_DATABASE_URL: "libsql://synthetic.turso.io",
              CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/test/turso/token",
            }
          : {}),
      },
      {
        sourceBucketName: "synthetic-source-bucket",
        sourceObjectKey: "source.zip",
        problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
        problemsScoring: {},
        problemsEndpoints: {},
        deployViaLambda: true,
      },
    );
    const assembly = app.synth();
    fixtures.push({
      backend: Template.fromStack(backend),
      application: Template.fromStack(application),
      tags: assembly.stacks.map((stack) => stack.tags),
      names: assembly.stacks.map((stack) => stack.stackName),
      outdir: join(directory, profile),
    });
  }
}, 120_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(index = 0) {
  const value = fixtures[index];
  if (!value) throw new Error("Missing synthesized profile");
  return value;
}

describe("restored single-installation cloud composition", () => {
  it("synthesizes cloud names by default and preserves the selected existing Lite names", () => {
    for (const index of [0, 1, 2])
      expect(fixture(index).names).toEqual([
        "tenkacloud-cloud-problem-deploy-test",
        "tenkacloud-cloud-test",
      ]);
    for (const index of [3, 4])
      expect(fixture(index).names).toEqual([
        "tenkacloud-lite-problem-deploy-test",
        "tenkacloud-lite-test",
      ]);
  });
  it("owns every runtime's log destination and keeps Cognito Delete in all main profiles", () => {
    for (const template of fixtures.flatMap((current) => [current.backend, current.application])) {
      const logs = template.findResources("AWS::Logs::LogGroup");
      for (const runtime of Object.values(template.findResources("AWS::Lambda::Function"))) {
        const ref = runtime.Properties.LoggingConfig?.LogGroup?.Ref;
        expect(ref, "including the generic S3 auto-delete provider").toBeDefined();
        expect(logs[ref]).toMatchObject({
          Properties: { RetentionInDays: expect.any(Number) },
          DeletionPolicy: "Delete",
        });
      }
      for (const [id, resource] of Object.entries(logs).filter(([id]) =>
        id.includes("OwnedRuntimeLogs"),
      ))
        expect(resource.Properties.RetentionInDays, id).toBe(1);
      for (const pool of Object.values(template.findResources("AWS::Cognito::UserPool")))
        expect(pool.DeletionPolicy).toBe("Delete");
    }
  });

  it("uses the verified account and region ahead of ambient CDK defaults", () => {
    expect(
      cloudDeploymentTarget({
        ...target,
        CDK_DEFAULT_ACCOUNT: "999999999999",
        CDK_DEFAULT_REGION: "eu-west-1",
      }),
    ).toEqual({ account: target.ACCOUNT_ID, region: target.REGION });
  });

  it("preserves original app-plane IDs and fixed local tenant without SaaS provisioning", () => {
    const { application, backend } = fixture();
    const resources = application.toJSON().Resources;
    expect(Object.keys(resources)).toContain("IdentityProvidertenantUserPoolC77ED8F6");
    application.resourceCountIs("AWS::Cognito::UserPool", 1);
    application.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    application.hasOutput("TenantId", { Value: "local" });
    for (const template of [application, backend]) {
      template.hasOutput("CloudComposition", { Value: CLOUD_COMPOSITION });
      expect(template.toJSON().Metadata.TenkaCloudCloudComposition).toBe(CLOUD_COMPOSITION);
      expect(JSON.stringify(template.toJSON())).not.toMatch(
        /TenantMapping|ServerlessSaaS|AWS::ApiGateway::Account/u,
      );
    }
  });

  it("preserves all original persistent, identity, API and execution resource IDs and key schemas", () => {
    const baseline = JSON.parse(
      readFileSync(new URL("./fixtures/lite-resource-identities.json", import.meta.url), "utf8"),
    ) as {
      profiles: Record<
        string,
        Record<string, Record<string, { Type: string; Properties?: Record<string, unknown> }>>
      >;
    };
    for (const [index, provider] of [
      [0, "dynamodb"],
      [1, "turso"],
      [3, "dynamodb"],
      [4, "turso"],
    ] as const) {
      const current = fixture(index);
      for (const kind of ["application", "backend"] as const) {
        const resources = current[kind].toJSON().Resources;
        for (const [id, expected] of Object.entries(baseline.profiles[provider]?.[kind] ?? {})) {
          expect(resources[id], `${provider}/${kind}/${id}`).toBeDefined();
          expect(resources[id]).toMatchObject(expected);
        }
      }
    }
  });

  it("keeps standard CDKToolkit assets and ownership on both stacks and every role", () => {
    const { application, backend, tags } = fixture();
    expect(tags).toHaveLength(2);
    for (const tag of tags)
      expect(tag).toMatchObject({ TenkaCloudProject: "cloud-hosting", Environment: "test" });
    for (const template of [application, backend]) {
      const json = JSON.stringify(template.toJSON());
      expect(json).toContain("hnb659fds");
      expect(json).not.toContain("custom123");
      for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
        expect(role.Properties.Tags).toEqual(
          expect.arrayContaining([
            { Key: "TenkaCloudProject", Value: "cloud-hosting" },
            { Key: "Environment", Value: "test" },
            { Key: "TenkaCloudRegion", Value: "us-east-1" },
          ]),
        );
      }
      expect(json).not.toContain("arn:aws:iam::aws:policy/AdministratorAccess");
    }
  });

  it("uses one API-scoped Lambda permission per function independently of route count", () => {
    const { application } = fixture();
    const permissions = Object.values(application.findResources("AWS::Lambda::Permission")).filter(
      (resource) => resource.Properties.Principal === "apigateway.amazonaws.com",
    );
    expect(permissions).toHaveLength(4);
    expect(
      Object.keys(application.findResources("AWS::ApiGateway::Method")).length,
    ).toBeGreaterThan(50);
    const byFunction = new Map<string, object[]>();
    for (const permission of permissions) {
      const key = JSON.stringify(permission.Properties.FunctionName);
      byFunction.set(key, [...(byFunction.get(key) ?? []), permission.Properties]);
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain("123456789012");
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain("/*/*/*");
    }
    for (const policies of byFunction.values()) {
      expect(policies).toHaveLength(1);
      expect(
        Buffer.byteLength(JSON.stringify({ Version: "2012-10-17", Statement: policies })),
      ).toBeLessThan(20_480);
    }
  });

  it("ships the original console contract with current event limits for both providers", () => {
    for (const index of [0, 1]) {
      const current = fixture(index);
      const deployment =
        current.application.toJSON().Resources
          .ApplicationAdminConsoleHostingRuntimeConfigDeploymentCustomResource177335E6;
      const source = deployment.Properties.SourceObjectKeys[0] as string;
      let rawConfig = readFileSync(
        join(current.outdir, `asset.${source.replace(/\.zip$/u, "")}`, "runtime-config.json"),
        "utf8",
      );
      for (const marker of Object.keys(deployment.Properties.SourceMarkers[0])) {
        rawConfig = rawConfig.replaceAll(marker, JSON.stringify("synthetic-cfn-token"));
      }
      const config = JSON.parse(rawConfig);
      expect(config).toMatchObject({
        tenantId: "local",
        tenantName: "TenkaCloud",
        isolation: "silo",
        eventLimits: { maxTeams: 99, maxProblems: 50 },
      });
      expect(config).not.toHaveProperty("mode");
    }
  });

  it("keeps organizer TOTP, closed signup, and protected custom claims", () => {
    const { application } = fixture();
    application.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
    });
    const client = Object.values(application.findResources("AWS::Cognito::UserPoolClient"))[0];
    expect(client?.Properties.WriteAttributes).not.toEqual(
      expect.arrayContaining(["custom:userRole", "custom:tenantId"]),
    );
  });

  it("removes all DynamoDB resources and grants in the Turso profile", () => {
    const { application, backend } = fixture(1);
    for (const template of [application, backend]) {
      template.resourceCountIs("AWS::DynamoDB::Table", 0);
      for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
        expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain('"dynamodb:');
      }
    }
    for (const template of [application, backend]) {
      template.hasOutput("TursoDatabaseUrl", { Value: "https://synthetic.turso.io" });
      template.hasOutput("TursoAuthTokenParameterName", { Value: "/TenkaCloud/test/turso/token" });
      template.hasOutput("CloudControlDataBackend", { Value: "turso" });
    }
  });

  it("uses Delete by default and Retain only for explicitly retained data tables", () => {
    for (const index of [0, 2]) {
      const { application, backend } = fixture(index);
      const tables = [application, backend].flatMap((template) =>
        Object.values(template.findResources("AWS::DynamoDB::Table")),
      );
      expect(tables.length).toBeGreaterThan(3);
      for (const table of tables) {
        expect(table.DeletionPolicy).toBe(index === 2 ? "Retain" : "Delete");
        expect(table.UpdateReplacePolicy).toBe(index === 2 ? "Retain" : "Delete");
      }
    }
  });

  it("scopes CloudFront invalidations and retains private SPA origins", () => {
    for (const template of [fixture().application, fixture().backend]) {
      const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement,
      );
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes("cloudfront:CreateInvalidation"))
          expect(statement.Resource).not.toBe("*");
      }
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    }
  });
});
