import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import {
  competitorAssumeRolePolicy,
  installationCompetitorConfig,
} from "../../lib/cloud-hosting/competitor-accounts.js";
import {
  type CloudControlDataConfiguration,
  cloudControlDataConfiguration,
  retainCloudDataTables,
} from "../../lib/cloud-hosting/config.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import {
  cloudExecutionArtifacts,
  nativeBattleArtifact,
} from "../../lib/cloud-hosting/execution-artifacts.js";
import { CloudHosting } from "../../lib/cloud-hosting/hosting.js";
import { cloudDeploymentTarget } from "../../lib/cloud-hosting/regions.js";
import { cloudStackTags } from "../../lib/cloud-hosting/stack-names.js";
import { standardSynthesizer } from "../../lib/cloud-hosting/synthesizer.js";
import {
  CLOUD_EVENT_LIMITS,
  SQL_EVENT_LIMITS,
} from "../../lib/problem-deploy/control-data/domain/events.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-synth-"));
let data: Template;
let application: Template;
let tursoData: Template;
let tursoApplication: Template;
let retainedData: Template;
let retainedApplication: Template;
let stackTags: Record<string, string>[];
beforeAll(() => {
  const assets = join(directory, "assets");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "index.html"),
    "<!doctype html><title>Synthetic static asset for CDK contract test</title>",
  );
  function synthesize(
    retainDataTables?: boolean,
    controlData: CloudControlDataConfiguration = { kind: "dynamodb" },
  ) {
    let outputDirectory = retainDataTables ? "retained.cdk.out" : "cdk.out";
    if (controlData.kind === "turso") outputDirectory = "turso.cdk.out";
    const app = new App({
      outdir: join(directory, outputDirectory),
      context: { "@aws-cdk/core:bootstrapQualifier": "custom123" },
    });
    const env = { account: "123456789012", region: "us-east-1" };
    const backend = new CloudDataStack(app, "CloudBackend", {
      environment: "test",
      controlData,
      ...(retainDataTables === undefined ? {} : { retainDataTables }),
      env,
      tags: cloudStackTags("test"),
      synthesizer: standardSynthesizer(),
      participantAssets: assets,
    });
    const stack = new CloudApplicationStack(app, "CloudApplication", {
      env,
      tags: cloudStackTags("test"),
      synthesizer: standardSynthesizer(),
      environment: "test",
      backend,
      consoleAssets: assets,
      repositoryRoot: resolve(import.meta.dirname, "../../.."),
    });
    // This also detects cross-stack dependency cycles. It performs no context lookup or AWS calls.
    stackTags = app.synth().stacks.map((artifact) => artifact.tags);
    return [Template.fromStack(backend), Template.fromStack(stack)] as const;
  }
  [data, application] = synthesize();
  [tursoData, tursoApplication] = synthesize(
    false,
    cloudControlDataConfiguration({
      CDK_PARAM_CONTROL_DATA_BACKEND: " TURSO ",
      CDK_PARAM_TURSO_DATABASE_URL: "libsql://synthetic.turso.io",
      CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/test/turso/auth-token",
    }),
  );
  [retainedData, retainedApplication] = synthesize(
    retainCloudDataTables({ CDK_PARAM_RETAIN_DATA_TABLES: "true" }),
  );
}, 60_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function assertRemovalPolicies(template: Template, retainTables: boolean): void {
  for (const [id, resource] of Object.entries(template.toJSON().Resources)) {
    const owned = resource as {
      Type: string;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    };
    const policy = retainTables && owned.Type === "AWS::DynamoDB::Table" ? "Retain" : "Delete";
    expect(owned.DeletionPolicy, id).toBe(policy);
    expect(owned.UpdateReplacePolicy, id).toBe(policy);
  }
  for (const table of Object.values(template.findResources("AWS::DynamoDB::Table")))
    expect(table.Properties.DeletionProtectionEnabled).toBe(false);
}

function assertBucketCleanup(template: Template): void {
  const buckets = Object.keys(template.findResources("AWS::S3::Bucket"));
  const emptying = Object.entries(template.findResources("Custom::S3AutoDeleteObjects"));
  expect(emptying).toHaveLength(buckets.length);
  for (const bucketId of buckets) {
    const cleanup = emptying.find(
      ([, resource]) => resource.Properties.BucketName.Ref === bucketId,
    );
    expect(cleanup).toBeDefined();
    const uploads = Object.values(template.findResources("Custom::CDKBucketDeployment")).filter(
      (resource) => resource.Properties.DestinationBucketName.Ref === bucketId,
    );
    for (const upload of uploads) expect(upload.DependsOn).toContain(cleanup?.[0]);
  }
}

function assertProviderLogs(template: Template): void {
  const logs = template.findResources("AWS::Logs::LogGroup");
  const deploymentLogs = Object.keys(logs).filter((id) => id.startsWith("BucketDeploymentLogs"));
  expect(deploymentLogs).toHaveLength(1);
  for (const log of Object.values(logs)) expect(log.Properties.RetentionInDays).toBeGreaterThan(0);
  const functions = Object.entries(template.findResources("AWS::Lambda::Function"));
  const deploymentProviders = functions.filter(([id]) =>
    id.startsWith("CustomCDKBucketDeployment"),
  );
  expect(deploymentProviders).toHaveLength(1);
  expect(deploymentProviders[0]?.[1].Properties.LoggingConfig.LogGroup).toEqual({
    Ref: deploymentLogs[0],
  });
  // CDK's auto-delete provider exposes no logGroup prop; its runtime-created group is
  // intentionally absent from synth and must be collected by exact stack-owned CLI cleanup.
  const implicit = functions.filter(([, resource]) => !resource.Properties.LoggingConfig?.LogGroup);
  expect(implicit).toHaveLength(1);
  expect(implicit[0]?.[0]).toMatch(/^CustomS3AutoDeleteObjectsCustomResourceProviderHandler/u);
}

describe("cloud CDK synth-only security and frontend wiring", () => {
  it("synthesizes and bundles every Turso handler without DynamoDB resources, names or permissions", () => {
    for (const template of [tursoData, tursoApplication]) {
      template.resourceCountIs("AWS::DynamoDB::Table", 0);
      expect(JSON.stringify(template.toJSON())).not.toMatch(
        /dynamodb:|EVENTS_TABLE_NAME|TEAMS_TABLE_NAME|DEPLOYMENTS_TABLE_NAME|GSI1/iu,
      );
      assertRemovalPolicies(template, false);
    }
    tursoData.hasOutput("CloudControlDataBackend", { Value: "turso" });
    tursoData.hasOutput("TursoDatabaseUrl", { Value: "https://synthetic.turso.io" });
    tursoData.hasOutput("TursoAuthTokenParameterName", {
      Value: "/TenkaCloud/test/turso/auth-token",
    });
    for (const name of ["EventsTableName", "TeamsTableName", "DeploymentsTableName"])
      expect(tursoData.toJSON().Outputs[name]).toBeUndefined();
    const functions = Object.values(tursoApplication.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties.Environment?.Variables?.CONTROL_DATA_BACKEND === "turso",
    );
    expect(functions).toHaveLength(8);
    for (const fn of functions) {
      expect(fn.Properties.Environment.Variables).toMatchObject({
        TURSO_DATABASE_URL: "https://synthetic.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/test/turso/auth-token",
      });
    }
    const policies = Object.values(tursoApplication.findResources("AWS::IAM::Policy"));
    const tokenReads = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) =>
        JSON.stringify(statement.Resource).includes("parameter/TenkaCloud/test/turso/auth-token"),
      );
    expect(tokenReads).toHaveLength(8);
    for (const statement of tokenReads) {
      expect([statement.Action].flat()).toEqual(["ssm:GetParameter"]);
      expect(JSON.stringify(statement.Resource)).not.toContain("parameter/*");
    }
    expect(JSON.stringify(policies)).toContain("sts:ExternalId");
    expect(JSON.stringify(policies)).toContain("ssm:PutParameter");
  });

  it("keeps the verified deployment account and region ahead of ambient CDK defaults", () => {
    const defaults = { CDK_DEFAULT_ACCOUNT: "222222222222", CDK_DEFAULT_REGION: "eu-west-1" };
    expect(
      cloudDeploymentTarget({
        ...defaults,
        ACCOUNT_ID: "123456789012",
        REGION: "us-east-1",
        AWS_REGION: "ap-northeast-1",
      }),
    ).toEqual({ account: "123456789012", region: "us-east-1" });
    expect(
      cloudDeploymentTarget({
        ...defaults,
        ACCOUNT_ID: "123456789012",
        AWS_REGION: "ap-northeast-1",
      }),
    ).toEqual({ account: "123456789012", region: "ap-northeast-1" });
    expect(cloudDeploymentTarget({ ...defaults, AWS_DEFAULT_REGION: "us-west-2" })).toEqual({
      account: "222222222222",
      region: "us-west-2",
    });
    expect(cloudDeploymentTarget(defaults)).toEqual({
      account: "222222222222",
      region: "eu-west-1",
    });
    expect(() => cloudDeploymentTarget({ ...defaults, ACCOUNT_ID: "" })).toThrow("12-digit");
    expect(() => cloudDeploymentTarget({ ...defaults, REGION: "" })).toThrow("commercial");
    expect(() => cloudDeploymentTarget({})).toThrow("commercial");
  });
  it("marks native-aware installation control so older destroy clients fail closed", () => {
    expect(application.toJSON().Outputs.CloudInstallationControlVersion.Value).toBe("2");
    application.hasOutput("CloudExecutionArtifactBucket", { Value: Match.anyValue() });
    application.hasOutput("CloudExecutionCatalogKey", {
      Value: Match.stringLikeRegexp("^catalogs/[a-f0-9]{64}\\.json$"),
    });
  });

  it("emits project and environment ownership tags on both CloudFormation stack artifacts", () => {
    expect(stackTags).toEqual([
      { ...cloudStackTags("test"), TenkaCloudRegion: "us-east-1" },
      { ...cloudStackTags("test"), TenkaCloudRegion: "us-east-1" },
    ]);
  });
  it.each(["dynamodb", "turso"])(
    "loads every declared %s Node handler from a bundle smaller than 1 MiB",
    (backend) => {
      const template = backend === "turso" ? tursoApplication : application;
      const functions = Object.entries(template.findResources("AWS::Lambda::Function")).filter(
        ([id]) => /^(CloudApi|DeploymentPipeline)/u.test(id),
      );
      const bundles = functions.map(([, resource]) => {
        expect(resource.Properties.Runtime).toBe("nodejs24.x");
        const handler = String(resource.Properties.Handler);
        expect(handler).toMatch(/^index\.[a-zA-Z]+$/u);
        const key = String(resource.Properties.Code.S3Key);
        expect(key).toMatch(/^[a-f0-9]{64}\.zip$/u);
        const file = join(
          directory,
          backend === "turso" ? "turso.cdk.out" : "cdk.out",
          `asset.${key.slice(0, -4)}`,
          "index.js",
        );
        expect(readFileSync(file).byteLength).toBeLessThan(1024 * 1024);
        return { file, handler: handler.slice("index.".length) };
      });
      expect(bundles.map(({ handler }) => handler).sort()).toEqual([
        "claimHandler",
        "createHandler",
        "describeHandler",
        "failHandler",
        "finishHandler",
        "handler",
        "handler",
        "recoveryHandler",
      ]);
      execFileSync(
        process.execPath,
        [
          "-e",
          'for (const { file, handler } of JSON.parse(process.argv[1])) require("node:assert/strict").equal(typeof require(file)[handler], "function", handler);',
          JSON.stringify(bundles),
        ],
        {
          env: {
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_REGION: "us-east-1",
            ...(backend === "turso"
              ? {
                  CONTROL_DATA_BACKEND: "turso",
                  TURSO_DATABASE_URL: "https://synthetic.turso.io",
                  TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/test/turso/auth-token",
                }
              : {
                  EVENTS_TABLE_NAME: "events",
                  TEAMS_TABLE_NAME: "teams",
                  DEPLOYMENTS_TABLE_NAME: "deployments",
                }),
          },
        },
      );
    },
  );
  it("retains ownership tags without requiring custom bootstrap IAM policies", () => {
    for (const source of [data, application]) {
      for (const role of Object.values(source.findResources("AWS::IAM::Role"))) {
        expect(role.Properties.PermissionsBoundary).toBeUndefined();
        expect(role.Properties.Tags).toContainEqual({
          Key: "TenkaCloudRegion",
          Value: "us-east-1",
        });
      }
    }
  });
  it("uses the standard CDK toolkit without project-specific IAM dependencies", () => {
    const templates = JSON.stringify([data.toJSON(), application.toJSON()]);
    expect(templates).toContain("hnb659fds");
    expect(templates).not.toContain("TenkaCloudToolkit-");
    expect(templates).not.toContain("custom123");
    expect(templates).not.toContain("policy/tenkacloud/cloud-hosting/");
  });
  it.each(["dynamodb", "turso"])(
    "publishes %s creation limits in the actual organizer runtime-config asset",
    (provider) => {
      const outdir = join(directory, provider === "turso" ? "turso.cdk.out" : "cdk.out");
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
        expect.objectContaining({
          eventLimits: provider === "turso" ? SQL_EVENT_LIMITS : CLOUD_EVENT_LIMITS,
          mode: "cloud-host",
          supportedProblemIds: ["hello-world", "ac26-crypto-battle"],
          nativeProblemIds: ["ac26-crypto-battle"],
          features: {
            samlSso: false,
            nonAwsRuntime: false,
            redTeam: false,
            challengePrerequisiteGate: false,
          },
        }),
      );
      expect(configs).toContainEqual(
        expect.objectContaining({
          mode: "backend",
          cloudMode: "real",
          hasAws: true,
          notificationsEnabled: false,
          scoreTimelineEnabled: false,
        }),
      );
    },
  );
  it("deletes owned data by default, keeps on-demand billing and does not TTL-delete history", () => {
    data.resourceCountIs("AWS::DynamoDB::Table", 3);
    const tables = data.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      expect(table.DeletionPolicy).toBe("Delete");
      expect(table.UpdateReplacePolicy).toBe("Delete");
      expect(table.Properties.DeletionProtectionEnabled).toBe(false);
      expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
      expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
      expect(table.Properties.KeySchema).toEqual([
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ]);
    }
  });
  it.each([undefined, "", "false", "1", "TRUE", "True", " true", "true "])(
    "keeps the original exact true retention opt-in (%s)",
    (value) => {
      expect(retainCloudDataTables({ CDK_PARAM_RETAIN_DATA_TABLES: value })).toBe(false);
    },
  );
  it.each([false, true])(
    "restores original removal policies across all owned resources (retain tables: %s)",
    (retainTables) => {
      const templates = retainTables ? [retainedData, retainedApplication] : [data, application];
      for (const template of templates) {
        assertRemovalPolicies(template, retainTables);
        assertBucketCleanup(template);
        assertProviderLogs(template);
      }
      templates[1]?.resourceCountIs("AWS::Cognito::UserPool", 1);
      templates[1]?.hasResource("AWS::S3::Bucket", {
        Properties: { VersioningConfiguration: { Status: "Enabled" } },
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
    },
  );
  it("does not change the regional API Gateway logging account setting", () => {
    application.resourceCountIs("AWS::ApiGateway::Account", 0);
    expect(JSON.stringify(application.toJSON())).not.toContain(
      "AmazonAPIGatewayPushToCloudWatchLogs",
    );
  });
  it("keeps API invoke policy below 20 KiB independently of route count, with account and stage bounds", () => {
    for (const template of [application, tursoApplication]) {
      const apiId = Object.keys(template.findResources("AWS::ApiGateway::RestApi"))[0];
      const stages = template.findResources("AWS::ApiGateway::Stage");
      expect(apiId).toBeDefined();
      const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
        (resource) => resource.Properties.Principal === "apigateway.amazonaws.com",
      );
      // #2947's regression: adding routes must never add per-method Lambda policy statements.
      expect(permissions).toHaveLength(2);
      const methods = Object.values(template.findResources("AWS::ApiGateway::Method")).filter(
        (resource) => resource.Properties.HttpMethod !== "OPTIONS",
      );
      expect(methods.length).toBeGreaterThan(20);
      const sourceArns = permissions.map(({ Properties: permission }) => {
        expect(permission.Action).toBe("lambda:InvokeFunction");
        expect(permission.SourceAccount).toBe("123456789012");
        expect(permission.FunctionName).toEqual({
          "Fn::GetAtt": [expect.stringMatching(/^CloudApi/u), "Arn"],
        });
        const [separator, parts] = permission.SourceArn["Fn::Join"];
        expect(separator).toBe("");
        return parts
          .map((part: string | { Ref: string }) => {
            if (typeof part === "string") return part;
            if (part.Ref === "AWS::Partition") return "aws";
            const stage = stages[part.Ref];
            if (stage) {
              expect(stage.Properties.RestApiId).toEqual({ Ref: apiId });
              expect(stage.Properties.StageName).toBe("prod");
              return stage.Properties.StageName;
            }
            expect(part.Ref).toBe(apiId);
            return "abcdefghij";
          })
          .join("");
      });
      expect(sourceArns.sort()).toEqual([
        "arn:aws:execute-api:us-east-1:123456789012:abcdefghij/prod/*/*",
        "arn:aws:execute-api:us-east-1:123456789012:abcdefghij/test-invoke-stage/*/*",
      ]);
      for (const method of methods) {
        expect(method.Properties.Integration.Type).toBe("AWS_PROXY");
        expect(method.Properties.Integration.IntegrationHttpMethod).toBe("POST");
      }
      // Bound real policy JSON using the maximum Lambda name/Sid lengths and a long commercial region.
      const policy = {
        Version: "2012-10-17",
        Id: "default",
        Statement: sourceArns.map((sourceArn: string) => ({
          Sid: "s".repeat(100),
          Effect: "Allow",
          Principal: { Service: "apigateway.amazonaws.com" },
          Action: "lambda:InvokeFunction",
          Resource: `arn:aws:lambda:ap-southeast-7:123456789012:function:${"f".repeat(64)}`,
          Condition: {
            ArnLike: { "AWS:SourceArn": sourceArn.replace(":us-east-1:", ":ap-southeast-7:") },
            StringEquals: { "AWS:SourceAccount": "123456789012" },
          },
        })),
      };
      expect(Buffer.byteLength(JSON.stringify(policy))).toBeLessThan(20480);
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
    expect(writes).toHaveLength(17);
    const resources = application.findResources("AWS::ApiGateway::Resource");
    const reset = Object.entries(resources).find(
      ([, resource]) => resource.Properties.PathPart === "reset",
    );
    expect(reset).toBeDefined();
    if (!reset) throw new Error("Native reset resource is missing");
    let resourceId = reset[0];
    for (const pathPart of [
      "reset",
      "coordination",
      "{problemId}",
      "problems",
      "{eventId}",
      "events",
    ]) {
      const resetResource = resources[resourceId];
      if (!resetResource) throw new Error(`Missing native reset resource: ${pathPart}`);
      expect(resetResource.Properties.PathPart).toBe(pathPart);
      resourceId = resetResource.Properties.ParentId?.Ref;
    }
    expect(writes).toContainEqual(
      expect.objectContaining({
        Properties: expect.objectContaining({
          HttpMethod: "POST",
          ResourceId: { Ref: reset[0] },
          AuthorizationType: "COGNITO_USER_POOLS",
          AuthorizerId: expect.any(Object),
        }),
      }),
    );
    const flagId = Object.entries(application.findResources("AWS::ApiGateway::Resource")).find(
      ([, resource]) => resource.Properties.PathPart === "submit-flag",
    )?.[0];
    expect(flagId).toBeDefined();
    const publicWrites = writes.filter(
      (method) => method.Properties.AuthorizationType !== "COGNITO_USER_POOLS",
    );
    expect(publicWrites).toHaveLength(2);
    const operationId = Object.entries(application.findResources("AWS::ApiGateway::Resource")).find(
      ([, resource]) => resource.Properties.PathPart === "op",
    )?.[0];
    expect(operationId).toBeDefined();
    expect(publicWrites.map((method) => method.Properties)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          HttpMethod: "POST",
          ResourceId: { Ref: flagId },
          AuthorizationType: "NONE",
        }),
        expect.objectContaining({
          HttpMethod: "POST",
          ResourceId: { Ref: operationId },
          AuthorizationType: "NONE",
        }),
      ]),
    );
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
  it.each(["dynamodb", "turso"] as const)(
    "limits %s API artifact reads to retained catalogs/plugins and the exact bindings object",
    (backend) => {
      const template = backend === "dynamodb" ? application : tursoApplication;
      const api = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
        id.startsWith("CloudApi"),
      )?.[1];
      const apiRole = Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
        id.startsWith("ApiRole"),
      );
      expect(api).toBeDefined();
      expect(apiRole).toBeDefined();
      const variables = api?.Properties.Environment.Variables;
      const bucketId = variables.CLOUD_ARTIFACT_BUCKET.Ref;
      const statements = Object.values(template.findResources("AWS::IAM::Policy"))
        .filter((policy) =>
          policy.Properties.Roles?.some((role: { Ref?: string }) => role.Ref === apiRole),
        )
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .filter((statement) =>
          [statement.Action]
            .flat()
            .some((action: string) => action === "*" || action.startsWith("s3:")),
        );
      const artifactArn = (key: string) => ({
        "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, `/${key}`]],
      });
      // Exact equality excludes bucket-list, writes, whole-bucket and other-bucket grants.
      expect(statements).toEqual([
        {
          Action: "s3:GetObject",
          Effect: "Allow",
          Resource: [
            artifactArn("catalogs/*"),
            artifactArn("plugins/*"),
            artifactArn(variables.CLOUD_RUNNER_BINDINGS_KEY),
          ],
        },
      ]);
      expect(variables.CLOUD_RUNNER_BINDINGS_KEY).toMatch(/^bindings\/[a-f0-9]{64}\.json$/u);
    },
  );
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
  const battle = join(root, "problems/battles/ac26-crypto-battle");
  const sdk = join(root, "packages/coordination-plugin-sdk");
  cpSync(resolve(import.meta.dirname, "../../../problems/battles/ac26-crypto-battle"), battle, {
    recursive: true,
  });
  cpSync(resolve(import.meta.dirname, "../../../packages/coordination-plugin-sdk"), sdk, {
    recursive: true,
  });
  mkdirSync(join(root, "node_modules/@tenkacloud"), { recursive: true });
  symlinkSync(sdk, join(root, "node_modules/@tenkacloud/coordination-plugin-sdk"), "dir");
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
    expect(outputs.CloudInstallationControlVersion.Value).toBe("2");
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
    expect(assumptions).toHaveLength(5);
    const competitorAssumptions = assumptions.filter(
      (statement) => statement.Resource === `arn:aws:iam::*:role/${config.roleName}`,
    );
    expect(competitorAssumptions).toHaveLength(4);
    for (const statement of competitorAssumptions)
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
    expect(
      assumptions.filter((statement) => statement.Resource === "arn:aws:iam::*:role/*"),
    ).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/TenkaCloud:Purpose": "participant-viewer",
            "aws:ResourceTag/TenkaCloud:ProblemId": "hello-world",
            "aws:ResourceTag/TenkaCloud:OperatorAccount": "123456789012",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal IAM policy variable.
            "sts:ExternalId": "${aws:ResourceTag/TenkaCloud:JobId}",
          },
          ArnLike: {
            "aws:ResourceTag/TenkaCloud:StackId": "arn:aws:cloudformation:*:*:stack/tc-cloud-*/*",
          },
          Null: { "sts:ExternalId": "false", "aws:ResourceTag/TenkaCloud:JobId": "false" },
        },
      },
    ]);
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
  it("keeps the shared bootstrap compatible with service-managed StackSets and requires ExternalId", () => {
    const stack = new Stack(
      new App({ outdir: join(directory, "competitor-stackset-template-synth") }),
      "SyntheticStackSetInstance",
    );
    new CfnInclude(stack, "Template", {
      templateFile: resolve(import.meta.dirname, "../../templates/competitor-bootstrap.yaml"),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::CloudFormation::Stack", 0);
    expect(template.toJSON().Transform).toBeUndefined();
    expect(Object.keys(template.toJSON().Resources)).toEqual(["CompetitorDeployRole"]);
    template.hasParameter("ExternalId", {
      Type: "String",
      NoEcho: true,
      MinLength: 16,
      MaxLength: 128,
    });
    expect(template.toJSON().Parameters.ExternalId.Default).toBeUndefined();
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: { Ref: "RoleName" },
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowTenkaCloudControlPlaneToAssume",
            Effect: "Allow",
            Principal: { AWS: { "Fn::Sub": `arn:aws:iam::\${TenkaCloudAccountId}:root` } },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
          },
        ],
      },
    });
  });
  it("reuses the three bootstrap parameters, exact account/ExternalId trust, and competitor-only AdministratorAccess exception", () => {
    const app = new App({ outdir: join(directory, "competitor-template-synth") });
    const stack = new Stack(app, "SyntheticCompetitor", {
      env: { account: "222222222222", region: "us-east-1" },
    });
    new CfnInclude(stack, "Template", {
      templateFile: resolve(import.meta.dirname, "../../templates/competitor-bootstrap.yaml"),
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
  it("pins the canonical viewer's explicit ownership tags without exposing the shared installation secret", () => {
    const stack = new Stack(
      new App({ outdir: join(directory, "viewer-template-synth") }),
      "SyntheticHelloWorld",
      {
        env: { account: "222222222222", region: "us-east-1" },
      },
    );
    const jobId = "01JTEST00000000000000000000";
    new CfnInclude(stack, "Template", {
      templateFile: resolve(
        import.meta.dirname,
        "../../../problems/challenges/hello-world/template.yaml",
      ),
      parameters: {
        NamePrefix: `tc-cloud-${"a".repeat(40)}`,
        TenkaCloudAccountId: "123456789012",
        ExternalId: jobId,
        FlagSeed: "SyntheticFlagOnly123",
      },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      Tags: Match.arrayWith([
        { Key: "TenkaCloud:JobId", Value: jobId },
        { Key: "TenkaCloud:OperatorAccount", Value: "123456789012" },
        { Key: "TenkaCloud:ProblemId", Value: "hello-world" },
        { Key: "TenkaCloud:Purpose", Value: "participant-viewer" },
        { Key: "TenkaCloud:StackId", Value: { Ref: "AWS::StackId" } },
      ]),
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: { "Fn::Sub": "arn:aws:iam::123456789012:root" } },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": jobId } },
          },
        ],
      },
    });
    const role = Object.values(template.findResources("AWS::IAM::Role"))[0];
    expect(role?.Properties.RoleName).toBeUndefined();
    expect(JSON.stringify(role?.Properties.Tags)).not.toContain("SyntheticFlagOnly123");
    expect(JSON.stringify(role?.Properties.Tags)).not.toMatch(
      /ssm|external-id|competitor-deploy/iu,
    );
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

describe("canonical native Battle artifact", () => {
  it("rejects a linked native entry rather than uploading mutable source", () => {
    const f = artifactFixture();
    const entry = join(f.root, "problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts");
    const target = join(f.root, "synthetic-plugin.ts");
    renameSync(entry, target);
    symlinkSync(target, entry);
    expect(() => nativeBattleArtifact(f.root)).toThrow("symbolic links");
  });
  it("rejects imports outside the reviewed pure closure", () => {
    const f = artifactFixture();
    const entry = join(f.root, "problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts");
    writeFileSync(
      entry,
      `${readFileSync(entry, "utf8")}\nimport fs from "node:fs"; console.log(fs);`,
    );
    expect(() => nativeBattleArtifact(f.root)).toThrow("unreviewed external import");
  });

  it("bundles canonical plugin without CloudFormation, external packages or local host services", async () => {
    const artifact = nativeBattleArtifact(resolve(import.meta.dirname, "../../.."));
    expect(artifact.descriptor).toMatchObject({
      kind: "coordination",
      problemId: "ac26-crypto-battle",
      stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    });
    expect(artifact.descriptor.pluginKey).toBe(
      `plugins/${createHash("sha256").update(artifact.source).digest("hex")}.mjs`,
    );
    expect(artifact.descriptor).not.toHaveProperty("templateBody");
    expect(artifact.source).not.toMatch(/bun:sqlite|HostingService|DynamoDB|from ["']@tenkacloud/u);
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(artifact.source).toString("base64")}`
    );
    const plugin = module.default;
    const state = plugin.initialState({
      eventId: "synthetic-event",
      teamIds: ["a", "b"],
      matchSecret: "d".repeat(64),
    });
    const projection = plugin.projectForTeam(state, "a");
    expect(projection).toBeDefined();
    expect(JSON.stringify(projection)).not.toContain("d".repeat(64));
  });
});
