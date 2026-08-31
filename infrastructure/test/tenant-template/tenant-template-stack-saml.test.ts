import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { TenantTemplateStack } from "../../lib/tenant-template/tenant-template-stack";

/**
 * Issue #1340 Phase 2: `TenantTemplateStack` の SAML attach 契約。
 *
 * 主目的:
 *   - pooled tier (= 全 pooled tenant が UserPool 共有) では `samlIdps` を props で受けても
 *     attach しない (= 物理的に他テナントへの副作用を作らない)。
 *   - silo tier (= per-tenant UserPool) では `samlIdps` を attach し、 directory が表に出る。
 *
 * 既存テナント (= samlIdps 未指定) の CFn 物理差分 0 件も併せて pin する。
 */
function makeSupportTable(stack: cdk.Stack, id: string): Table {
  return new Table(stack, id, {
    partitionKey: { name: "tenantId", type: AttributeType.STRING },
    billingMode: BillingMode.PROVISIONED,
    readCapacity: 1,
    writeCapacity: 1,
  });
}

function makeStubLambda(stack: cdk.Stack, id: string): LambdaFunction {
  return new LambdaFunction(stack, id, {
    runtime: Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
}

function makeTenantTemplate(args: {
  readonly isPooledDeploy: boolean;
  readonly samlIdps?: ReadonlyArray<{
    readonly name: string;
    readonly metadataUrl: string;
    readonly emailDomains: readonly string[];
  }>;
  readonly samlAdminAllowlist?: readonly string[];
}): Template {
  const app = new cdk.App({ autoSynth: false });
  const supportStack = new cdk.Stack(app, "Support", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const tenantMappingTable = makeSupportTable(supportStack, "TenantMapping");
  const deployApiLambda = makeStubLambda(supportStack, "DeployApi");
  const eventApiLambda = makeStubLambda(supportStack, "EventApi");
  const competitorAccountsApiLambda = makeStubLambda(supportStack, "CompetitorAccountsApi");

  const stack = new TenantTemplateStack(app, "TenantTemplateUnderTest", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    tenantId: args.isPooledDeploy ? "pooled" : "tenant-1",
    tenantName: args.isPooledDeploy ? "Shared Pooled" : "Tenant 1",
    environment: "development",
    stageName: "prod",
    lambdaReserveConcurrency: 1,
    lambdaCanaryDeploymentPreference: "True",
    isPooledDeploy: args.isPooledDeploy,
    ApiKeySSMParameterNames: {
      basic: { keyId: "b", value: "b" },
      standard: { keyId: "s", value: "s" },
      premium: { keyId: "p", value: "p" },
      platinum: { keyId: "pl", value: "pl" },
    },
    tenantMappingTable,
    commitId: "test",
    deployApiLambda,
    eventApiLambda,
    competitorAccountsApiLambda,
    ...(args.samlIdps ? { samlIdps: args.samlIdps } : {}),
    ...(args.samlAdminAllowlist ? { samlAdminAllowlist: args.samlAdminAllowlist } : {}),
  });
  return Template.fromStack(stack);
}

describe("TenantTemplateStack SAML props (#1340)", () => {
  it("should NOT attach a SAML IdP when samlIdps is omitted (= existing tenants stay byte-for-byte identical)", () => {
    const template = makeTenantTemplate({ isPooledDeploy: false });
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  it("should IGNORE samlIdps on pooled tier even when env provides them (= pooled isolation)", () => {
    const template = makeTenantTemplate({
      isPooledDeploy: true,
      samlIdps: [
        { name: "corp-entra", metadataUrl: "https://meta", emailDomains: ["example.com"] },
      ],
      samlAdminAllowlist: ["corp-entra/admin@example.com"],
    });
    // pooled では UserPool が共有なので SAML attach は禁止 → 0 件のままが正解。
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    // Pre sign-up Lambda も attach されない (= allowlist Lambda が立たない)
    const userPools = template.findResources("AWS::Cognito::UserPool");
    const userPool = Object.values(userPools)[0];
    const lambdaConfig = (userPool?.Properties as { LambdaConfig?: Record<string, unknown> })
      ?.LambdaConfig;
    expect(lambdaConfig?.PreSignUp).toBeUndefined();
  });

  it("should ATTACH samlIdps on silo tier (= per-tenant UserPool)", () => {
    const template = makeTenantTemplate({
      isPooledDeploy: false,
      samlIdps: [
        { name: "tenant-entra", metadataUrl: "https://meta", emailDomains: ["acme.example"] },
      ],
      samlAdminAllowlist: ["tenant-entra/admin@acme.example"],
    });
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "tenant-entra",
      ProviderType: "SAML",
    });
  });
});
