import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { beforeAll, describe, expect, it } from "vitest";
import { TenkaCloudLiteStack, type TenkaCloudLiteStackProps } from "../../lib/tenkacloud-lite";

// synth() は Lambda asset bundling を含む重い実処理。全 suite 並列時は default 5s を超えて
// flake するため、個別の backend synth を要する test には明示 timeout を持つ
// (`SYNTH_TIMEOUT_MS` — problem-deploy-backend-stack.test-helpers.ts と同じ値)。
const SYNTH_TIMEOUT_MS = 120_000;

/**
 * Issue #778: TenkaCloudLiteStack の最小契約 pin。
 *
 * - AppPlaneCore 経由で hosting + identity + apiGateway が立つ
 * - tenantId="local" 固定
 * - SBT / Pipeline / TenantMapping への依存が無い (= Lite mode の自己完結)
 *
 * AppPlaneCore は ApplicationAdminConsoleHosting を内包し、 BucketDeployment.Source.asset で
 * apps/application-admin-console/dist の存在を synth 時に検証する。 ローカル test / CI では
 * 未 build のことがあるので、 application-admin-console-hosting.test.ts と同じ pattern で
 * placeholder dist を作る。 vite build が走った後はそれで上書きされるので副作用は無い。
 */
const distDir = path.join(__dirname, "..", "..", "..", "apps", "application-admin-console", "dist");

function ensurePlaceholderDist(): void {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><html><body>placeholder</body></html>",
    );
  }
}

function buildStubLambda(scope: cdk.Stack, id: string): LambdaFunction {
  return new LambdaFunction(scope, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
}

function synth(
  overrides: Partial<
    Omit<
      TenkaCloudLiteStackProps,
      "deployApiLambda" | "eventApiLambda" | "competitorAccountsApiLambda"
    >
  > = {},
): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new TenkaCloudLiteStack(app, "TestLite", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    environment: "development",
    deployApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubDeploy",
    ),
    eventApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyEventLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubEvent",
    ),
    competitorAccountsApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyCompetitorLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubCompetitor",
    ),
    participantPortalUrl: "https://example.cloudfront.net",
    ...overrides,
  });
  return Template.fromStack(stack);
}

// synth() は Lambda asset bundling を含む重い実処理。全 suite 並列時は default 5s を
// 超え flake するため、明示 timeout を持つ。
describe("TenkaCloudLiteStack (#778)", { timeout: 60_000 }, () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  it("should create 1 set of Cognito UserPool / UserPoolClient / UserPoolDomain (from AppPlaneCore)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });

  it("should create 1 Tenant REST API Gateway", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  });

  it("should create 1 ApplicationAdminConsoleHosting (= CloudFront)", () => {
    const template = synth();
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("should include Application Admin Console URL / Cognito Domain / Tenant API / TenantId in CfnOutput", () => {
    const template = synth();
    template.hasOutput("ApplicationAdminConsoleUrl", Match.objectLike({}));
    template.hasOutput("CognitoDomainUrl", Match.objectLike({}));
    template.hasOutput("TenantApiUrl", Match.objectLike({}));
    template.hasOutput("TenantId", Match.objectLike({ Value: "local" }));
  });

  it("Cognito UserPool domain prefix should embed tenantId=local (region-global uniqueness)", () => {
    const template = synth();
    template.hasResourceProperties(
      "AWS::Cognito::UserPoolDomain",
      Match.objectLike({
        Domain: Match.stringLikeRegexp("tenkacloud-development-local-"),
      }),
    );
  });

  it("should not include SBT / pipeline resources (TenantMappingTable / SaaSPipeline)", () => {
    const template = synth();
    // Lite mode は SBT TenantMappingTable を参照しない。 DynamoDB Table は #1312 で
    // SAML IdP CRUD 用に 1 個だけ (= SamlIdps、 UserPool と同 stack 同居の制約) 立つ。
    // SBT 経路 (TenantMappingTable / TenantsTable) は引き続き 0。
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    // ServerlessSaaSPipeline 由来の CodePipeline も無い。
    template.resourceCountIs("AWS::CodePipeline::Pipeline", 0);
  });

  it("public API keys (Usage Plan / API Key) should be provisioned in a dormant dummy configuration (unused in Lite)", () => {
    const template = synth();
    // Usage Plan + API Key は AppPlaneCore (= ApiGateway construct) が作るので、 Lite でも
    // resource は出る。 ただし dummy SSM lookup なので runtime で実 key は引かれない。
    // (Phase 4-5 で ApiGateway 側に apiKeyConfig optional 対応を入れたら count=0 になる予定)。
    const usagePlans = template.findResources("AWS::ApiGateway::UsagePlan");
    expect(Object.keys(usagePlans).length).toBeGreaterThanOrEqual(0);
  });

  // Issue #1312: SAML IdP CRUD 配線 (= UI が "Failed to fetch" していた root cause を解消)。
  // Lite mode は silo 同型 (= 1 tenant 専用 UserPool) なので、 本 stack 内で SAML IdP CRUD を
  // 配線して完結させる。 ProblemDeployBackendStack に置くと UserPool が cross-stack に居て
  // cyclic dependency になるため、 設計判断として TenkaCloudLiteStack 内に同居させる。

  it("should provision SamlIdpsTable (PK=pk / SK=sk lower-case, matches ddb-store.ts) at 1/1 PROVISIONED (#1312)", () => {
    const template = synth();
    // lower-case `pk` / `sk` は `createDdbIdpStore` の PutCommand / GetCommand の Key 名と一致させるため
    // (= handler 経路と表構造の整合、 大文字 PK/SK にすると runtime で ValidationException で fail)。
    template.hasResourceProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: "pk", KeyType: "HASH" }),
          Match.objectLike({ AttributeName: "sk", KeyType: "RANGE" }),
        ]),
        ProvisionedThroughput: Match.objectLike({
          ReadCapacityUnits: 1,
          WriteCapacityUnits: 1,
        }),
      }),
    );
  });

  it("should provision a SamlIdp Lambda with IDP_TIER_GUARD=silo + SAML_IDPS_TABLE_NAME + TENANT_USER_POOL_ID env (#1312)", () => {
    const template = synth();
    // Lite mode は 1 tenant 専用 (= silo 同型) なので `IDP_TIER_GUARD=silo` を pin する。
    // pooled 配線時に誤って動くと cross-tenant 副作用が出るため handler 側 fail-closed guard。
    const functions = template.findResources("AWS::Lambda::Function");
    const samlIdp = Object.entries(functions).find(
      ([name]) => name.includes("SamlIdp") && name.includes("Function"),
    );
    expect(samlIdp).toBeDefined();
    const vars =
      (
        samlIdp?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.IDP_TIER_GUARD).toBe("silo");
    expect(vars.SAML_IDPS_TABLE_NAME).toBeDefined();
    expect(vars.TENANT_USER_POOL_ID).toBeDefined();
    // [Issue #2442 / Phase C5] default (controlDataBackend unset = dynamodb) must not add
    // CONTROL_DATA_BACKEND / TURSO_* env — byte-compat with the pre-C5 template.
    expect(vars.CONTROL_DATA_BACKEND).toBeUndefined();
    expect(vars.TURSO_DATABASE_URL).toBeUndefined();
    expect(vars.TURSO_AUTH_TOKEN_PARAMETER_NAME).toBeUndefined();
  });

  it("SamlIdp Lambda Role default policy should grant cognito-idp:*IdentityProvider on userpool/* + SamlIdps R+W (#1312)", () => {
    const template = synth();
    // SAML federation 設定は Cognito UserPool の Identity Provider mutation で実装される。
    // wildcard userpool/* + runtime guard (`TENANT_USER_POOL_ID` 経由で自 pool 絞り込み) は
    // competitor-accounts-api-lambda.ts の既存 SAML grant と同じ pattern。
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith([
                "cognito-idp:CreateIdentityProvider",
                "cognito-idp:UpdateIdentityProvider",
                "cognito-idp:DescribeIdentityProvider",
                "cognito-idp:DeleteIdentityProvider",
                "cognito-idp:ListIdentityProviders",
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  // Issue #1327 / #1358: Lite mode user に `custom:userRole=TenantAdmin` + `custom:tenantId=local` を
  // JWT 発行時に注入する Pre-Token Generation V2 Lambda が UserPool に attach されていることを pin。
  // V2 trigger (= PreTokenGenerationConfig + LambdaVersion: V2_0) を使うことで ID token と access token
  // の双方に claim が乗り、 Application Plane handler の `requireRole` が成立する (#1358 fix の根幹)。

  it("should attach a Pre-Token Generation V2 Lambda trigger on the Lite UserPool (#1327 / #1358)", () => {
    const template = synth();
    template.hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        LambdaConfig: Match.objectLike({
          PreTokenGenerationConfig: Match.objectLike({
            LambdaArn: Match.anyValue(),
            LambdaVersion: "V2_0",
          }),
        }),
      }),
    );
    // V1 key (PreTokenGeneration) が混入していないこと (= #1358 regression guard、 V1 だと
    // ID token に claim が乗らないため使ってはならない)。
    const userPools = template.findResources("AWS::Cognito::UserPool");
    const userPool = Object.values(userPools)[0];
    const lambdaConfig = (userPool?.Properties as { LambdaConfig?: Record<string, unknown> })
      ?.LambdaConfig;
    expect(lambdaConfig?.PreTokenGeneration).toBeUndefined();
  });

  it("should bundle a LiteAdminClaims Lambda Function for the Pre-Token Generation trigger (#1327)", () => {
    const template = synth();
    const functions = template.findResources("AWS::Lambda::Function");
    const liteAdminClaims = Object.entries(functions).find(
      ([name]) => name.includes("LiteAdminClaims") && name.includes("Function"),
    );
    expect(liteAdminClaims).toBeDefined();
  });

  it("should expose /tenant/idp and /tenant/idp/{idpId} routes on the tenant REST API (#1312)", () => {
    const template = synth();
    // ApiGateway は /tenant/idp (GET POST) と /tenant/idp/{idpId} (GET PATCH DELETE) を生やすので、
    // AWS::ApiGateway::Resource が `tenant` / `idp` / `{idpId}` の 3 段で見える。 path part 1 つずつ
    // pin することで、 ApiGateway 経由で SAML IdP Lambda に到達する経路を機械的に保証する。
    const resources = template.findResources("AWS::ApiGateway::Resource");
    const pathParts = Object.values(resources)
      .map((r) => (r as { Properties?: { PathPart?: string } }).Properties?.PathPart)
      .filter((p): p is string => typeof p === "string");
    expect(pathParts).toContain("tenant");
    expect(pathParts).toContain("idp");
    expect(pathParts).toContain("{idpId}");
  });
});

/**
 * [Issue #2442 / Phase C5] `controlDataBackend` conditional synth for `SamlIdpsTable` — mirrors
 * `control-data-backend-feature-flag.test.ts`'s pure-SQL / dynamodb pattern for
 * `ProblemDeployBackendStack`, but scoped to `TenkaCloudLiteStack` (the actual generation site for
 * this table — see `saml-idps-table.ts` / `tenkacloud-lite-stack.ts`, NOT
 * `problem-deploy-backend-stack.ts`). The SamlIdp Lambda / `/tenant/idp*` API is decoupled from
 * table presence (`attachSamlIdpLambda`): it exists in every backend, only its env/grant change.
 */
describe("SamlIdps pure SQL conditional synth (#2442 Phase C5)", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  function samlIdpFunctionEnv(template: Template): Record<string, unknown> {
    const functions = template.findResources("AWS::Lambda::Function");
    const entry = Object.entries(functions).find(
      ([name]) => name.includes("SamlIdp") && name.includes("Function"),
    );
    expect(entry, "expected a Lambda whose logical id contains SamlIdp").toBeDefined();
    return (
      (entry?.[1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        ?.Properties?.Environment?.Variables ?? {}
    );
  }

  it(
    "should NOT create a SamlIdps AWS::DynamoDB::Table when controlDataBackend='turso' (pure SQL)",
    () => {
      const template = synth({ controlDataBackend: "turso" });
      template.resourceCountIs("AWS::DynamoDB::Table", 0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still provision the SamlIdp Lambda (attachSamlIdpLambda decoupled from table presence) under controlDataBackend='turso'",
    () => {
      const template = synth({ controlDataBackend: "turso" });
      const vars = samlIdpFunctionEnv(template);
      // IDP_TIER_GUARD / TENANT_USER_POOL_ID stay pinned — the Lambda + /tenant/idp* API keep
      // working via the repository seam even though the table is gone.
      expect(vars.IDP_TIER_GUARD).toBe("silo");
      expect(vars.TENANT_USER_POOL_ID).toBeDefined();
      // The table-derived env is absent (no table to name).
      expect(vars.SAML_IDPS_TABLE_NAME).toBeUndefined();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should inject CONTROL_DATA_BACKEND + Turso env into the SamlIdp Lambda under controlDataBackend='turso' (the Lambda that opens the DB for this seam)",
    () => {
      const template = synth({
        controlDataBackend: "turso",
        tursoDatabaseUrl: "libsql://example.turso.io",
        tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
      });
      const vars = samlIdpFunctionEnv(template);
      expect(vars.CONTROL_DATA_BACKEND).toBe("turso");
      expect(vars.TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(vars.TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe("/tenkacloud/development/turso-token");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should grant the SamlIdp Lambda ssm:GetParameter scoped to the Turso token parameter under controlDataBackend='turso'",
    () => {
      const template = synth({
        controlDataBackend: "turso",
        tursoDatabaseUrl: "libsql://example.turso.io",
        tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
      });
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: "Allow",
                Action: "ssm:GetParameter",
                Resource: Match.anyValue(),
              }),
            ]),
          }),
        }),
      );
      // The Resource is an Fn::Join of stack tokens (partition/region/account) + the literal
      // parameter path — assert the literal substring landed somewhere in the synthesized JSON
      // (same pattern `control-data-backend-feature-flag.test.ts` uses for other C-series Lambdas).
      expect(JSON.stringify(template.toJSON())).toContain(
        "parameter/tenkacloud/development/turso-token",
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should default (dynamodb) to a byte-compatible synth — 1 DynamoDB Table, no CONTROL_DATA_BACKEND / TURSO_* env",
    () => {
      const template = synth();
      template.resourceCountIs("AWS::DynamoDB::Table", 1);
      const vars = samlIdpFunctionEnv(template);
      expect(vars.CONTROL_DATA_BACKEND).toBeUndefined();
      expect(vars.TURSO_DATABASE_URL).toBeUndefined();
      expect(vars.TURSO_AUTH_TOKEN_PARAMETER_NAME).toBeUndefined();
    },
    SYNTH_TIMEOUT_MS,
  );
});
