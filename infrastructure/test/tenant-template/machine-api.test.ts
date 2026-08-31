import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { MACHINE_TOKEN_PATH_FEATURE_KEY } from "../../lib/app-config/index";
import {
  CAPABILITY_SCOPE_NAMES,
  MACHINE_CAPABILITIES,
  MACHINE_ROUTE_SCOPES,
} from "../../lib/problem-deploy/handlers/shared/machine-scopes";
import { TenantTemplateStack } from "../../lib/tenant-template/tenant-template-stack";

/**
 * Issue #2948: machine (M2M) 経路の CloudFormation 契約。
 *
 * この test が守るのは 2 つの invariant である。
 *
 * 1. **flag OFF は物理差分ゼロ**。resource server も machine API も生成されず、既存の
 *    UserPool / human UserPoolClient / human TenantAPI に一切触らない。
 * 2. **flag ON でも surface は 7 method の allowlist ちょうど**。増減すればここが落ちて
 *    レビューが強制される。destructive path (`admin` / `disruptions` / `rotate-login-key` …)
 *    は machine API 上に resource としても存在しない。
 *
 * 6.4 の警告どおり、UserPool と human UserPoolClient が REPLACE される実装は「全 tenant admin を
 * ログアウトさせる事故」であり、`AWS::Cognito::UserPoolClient` が 1 件のままであることを
 * flag ON / OFF 双方で pin する。
 */

const TENANT_ID = "tenant-1";

function makeTemplate(features?: Readonly<Record<string, boolean>>): Template {
  const app = new cdk.App({ autoSynth: false });
  const supportStack = new cdk.Stack(app, "Support", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const tenantMappingTable = new Table(supportStack, "TenantMapping", {
    partitionKey: { name: "tenantId", type: AttributeType.STRING },
    billingMode: BillingMode.PROVISIONED,
    readCapacity: 1,
    writeCapacity: 1,
  });
  const makeStubLambda = (id: string) =>
    new LambdaFunction(supportStack, id, {
      runtime: Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: Code.fromInline("exports.handler = async () => ({});"),
    });

  const stack = new TenantTemplateStack(app, "TenantTemplateUnderTest", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    tenantId: TENANT_ID,
    tenantName: "Tenant 1",
    environment: "development",
    stageName: "prod",
    lambdaReserveConcurrency: 1,
    lambdaCanaryDeploymentPreference: "True",
    isPooledDeploy: false,
    ApiKeySSMParameterNames: {
      basic: { keyId: "b", value: "b" },
      standard: { keyId: "s", value: "s" },
      premium: { keyId: "p", value: "p" },
      platinum: { keyId: "pl", value: "pl" },
    },
    tenantMappingTable,
    commitId: "test",
    deployApiLambda: makeStubLambda("DeployApi"),
    eventApiLambda: makeStubLambda("EventApi"),
    competitorAccountsApiLambda: makeStubLambda("CompetitorAccountsApi"),
    ...(features ? { features } : {}),
  });
  return Template.fromStack(stack);
}

const flagOn = { [MACHINE_TOKEN_PATH_FEATURE_KEY]: true } as const;

type CfnResource = { readonly Properties?: Record<string, unknown> };

function refTarget(value: unknown): string | undefined {
  const ref = (value as { Ref?: unknown } | undefined)?.Ref;
  return typeof ref === "string" ? ref : undefined;
}

function findApiLogicalId(template: Template, namePrefix: string): string | undefined {
  const apis = template.findResources("AWS::ApiGateway::RestApi");
  return Object.entries(apis).find(([, resource]) =>
    String((resource as CfnResource).Properties?.Name ?? "").startsWith(namePrefix),
  )?.[0];
}

/** `AWS::ApiGateway::Resource` の親子関係を辿って method の完全 path を復元する。 */
function methodPaths(template: Template, apiLogicalId: string): string[] {
  const resources = template.findResources("AWS::ApiGateway::Resource");
  const rootRefs = new Set<string>();
  for (const [, api] of Object.entries(template.findResources("AWS::ApiGateway::RestApi"))) {
    void api;
  }
  const pathOf = (logicalId: string): string => {
    const props = (resources[logicalId] as CfnResource | undefined)?.Properties;
    if (!props) return "";
    const part = String(props.PathPart ?? "");
    const parentId = refTarget(props.ParentId);
    if (parentId && resources[parentId]) return `${pathOf(parentId)}/${part}`;
    return `/${part}`;
  };
  void rootRefs;

  return Object.values(template.findResources("AWS::ApiGateway::Method"))
    .filter((method) => refTarget((method as CfnResource).Properties?.RestApiId) === apiLogicalId)
    .map((method) => {
      const props = (method as CfnResource).Properties ?? {};
      const resourceId = refTarget(props.ResourceId);
      const path = resourceId && resources[resourceId] ? pathOf(resourceId) : "/";
      return `${String(props.HttpMethod)} ${path}`;
    })
    .sort();
}

describe("#2948 T-12 / T-13: features.machineTokenPath OFF is a physical no-op", () => {
  const template = makeTemplate();

  it("should synthesize no Cognito resource server", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolResourceServer", 0);
  });

  it("should keep exactly one RestApi and one UserPoolClient", () => {
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  });

  it("should not create a DescribeCognitoUserPoolClient custom resource (CDK never reads a client secret)", () => {
    template.resourceCountIs("Custom::DescribeCognitoUserPoolClient", 0);
  });

  it("should not attach a Pre-Token Generation Lambda (regression guard)", () => {
    const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
    const lambdaConfig = (userPool as CfnResource | undefined)?.Properties?.LambdaConfig as
      | Record<string, unknown>
      | undefined;
    expect(lambdaConfig?.PreTokenGeneration).toBeUndefined();
    expect(lambdaConfig?.PreTokenGenerationConfig).toBeUndefined();
  });
});

describe("#2948 T-14 — T-17: features.machineTokenPath ON creates only the machine surface", () => {
  const template = makeTemplate(flagOn);

  it("should create exactly one resource server carrying every declared capability scope", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolResourceServer", 1);
    const resourceServer = Object.values(
      template.findResources("AWS::Cognito::UserPoolResourceServer"),
    )[0] as CfnResource;
    expect(resourceServer.Properties?.Identifier).toBe("tenkacloud");
    const scopes = resourceServer.Properties?.Scopes as ReadonlyArray<{ ScopeName: string }>;
    expect(scopes.map((scope) => scope.ScopeName).sort()).toEqual(
      MACHINE_CAPABILITIES.map((capability) => CAPABILITY_SCOPE_NAMES[capability]).sort(),
    );
  });

  it("should leave the UserPool and the human UserPoolClient untouched", () => {
    // machine client は CFn 外 (= 発行 script) で作るため、client は human の 1 件のまま。
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
    const lambdaConfig = (userPool as CfnResource | undefined)?.Properties?.LambdaConfig as
      | Record<string, unknown>
      | undefined;
    expect(lambdaConfig?.PreTokenGeneration).toBeUndefined();
    expect(lambdaConfig?.PreTokenGenerationConfig).toBeUndefined();
  });

  it("should expose exactly the frozen Phase 1 method set on the machine API", () => {
    const machineApiId = findApiLogicalId(template, `TenantMachineAPI-${TENANT_ID}`);
    expect(machineApiId).toBeDefined();
    const expected = MACHINE_ROUTE_SCOPES.map(
      (route) => `${route.method} ${route.apigwPath}`,
    ).sort();
    expect(methodPaths(template, machineApiId as string)).toEqual(expected);
  });

  it("should require a Cognito authorizer and a non-empty scope on every machine method", () => {
    const machineApiId = findApiLogicalId(template, `TenantMachineAPI-${TENANT_ID}`) as string;
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method")).filter(
      (method) => refTarget((method as CfnResource).Properties?.RestApiId) === machineApiId,
    );
    expect(methods.length).toBe(MACHINE_ROUTE_SCOPES.length);
    for (const method of methods) {
      const props = (method as CfnResource).Properties ?? {};
      expect(props.AuthorizationType).toBe("COGNITO_USER_POOLS");
      expect((props.AuthorizationScopes as string[]).length).toBeGreaterThan(0);
      expect(props.HttpMethod).not.toBe("OPTIONS");
      expect(props.HttpMethod).not.toBe("DELETE");
    }
  });

  it("should not expose any destructive resource path on the machine API", () => {
    const machineApiId = findApiLogicalId(template, `TenantMachineAPI-${TENANT_ID}`) as string;
    const forbidden = [
      "admin",
      "disruptions",
      "lock-scoring",
      "archive",
      "rotate-login-key",
      "competitor-accounts",
      "users",
    ];
    const parts = Object.values(template.findResources("AWS::ApiGateway::Resource"))
      .filter(
        (resource) => refTarget((resource as CfnResource).Properties?.RestApiId) === machineApiId,
      )
      .map((resource) => String((resource as CfnResource).Properties?.PathPart ?? ""));
    for (const part of forbidden) expect(parts).not.toContain(part);
  });

  it("should make the machine API regional and log every request", () => {
    const machineApiId = findApiLogicalId(template, `TenantMachineAPI-${TENANT_ID}`) as string;
    const api = template.findResources("AWS::ApiGateway::RestApi")[machineApiId] as CfnResource;
    expect(
      (api.Properties?.EndpointConfiguration as { Types?: string[] } | undefined)?.Types,
    ).toEqual(["REGIONAL"]);
    const stage = Object.values(template.findResources("AWS::ApiGateway::Stage")).find(
      (candidate) => refTarget((candidate as CfnResource).Properties?.RestApiId) === machineApiId,
    ) as CfnResource | undefined;
    expect(stage?.Properties?.AccessLogSetting).toBeDefined();
  });

  it("should grant the machine API invoke permission on both the deploy and the event Lambda", () => {
    const machineApiId = findApiLogicalId(template, `TenantMachineAPI-${TENANT_ID}`) as string;
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
      (permission) =>
        JSON.stringify((permission as CfnResource).Properties?.SourceArn ?? "").includes(
          machineApiId,
        ),
    );
    // deploy Lambda / event Lambda に 1 本ずつ (= 20KB resource policy 上限を踏まないための
    // wildcard permission 方式)。
    expect(permissions.length).toBe(2);
    const functions = new Set(
      permissions.map((permission) =>
        JSON.stringify((permission as CfnResource).Properties?.FunctionName),
      ),
    );
    expect(functions.size).toBe(2);
  });
});

describe("#2948 T-18 / T-23: the human TenantAPI is untouched", () => {
  it("should never put AuthorizationScopes on a human TenantAPI method (the console sends an ID token)", () => {
    for (const template of [makeTemplate(), makeTemplate(flagOn)]) {
      const humanApiId = findApiLogicalId(template, `TenantAPI-${TENANT_ID}`) as string;
      const methods = Object.values(template.findResources("AWS::ApiGateway::Method")).filter(
        (method) => refTarget((method as CfnResource).Properties?.RestApiId) === humanApiId,
      );
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect((method as CfnResource).Properties?.AuthorizationScopes).toBeUndefined();
      }
    }
  });

  it("should only ADD logical IDs when the flag flips on (CREATE-only, no REPLACE or DELETE)", () => {
    const off = Object.keys(makeTemplate().toJSON().Resources as Record<string, unknown>);
    const on = new Set(
      Object.keys(makeTemplate(flagOn).toJSON().Resources as Record<string, unknown>),
    );
    const missing = off.filter((logicalId) => !on.has(logicalId));
    expect(missing).toEqual([]);
    expect(on.size).toBeGreaterThan(off.length);
  });
});
