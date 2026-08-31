import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../lib/control-plane-stack";

/**
 * Issue #1293 の CDK 配線 (#2941) を CFn 出力で固定する。
 *
 * 背景: handler / IAM だけ足して **route 登録を忘れる** と、 API Gateway の未マッチ 404 には
 * CORS header が付かず、 ブラウザには `Failed to fetch` としか出ない (= PR-683 で実際に起きた
 * 失敗を `/admin/idp` で再演していた)。 route の存在は synth 出力でしか担保できないのでここで pin する。
 *
 * さらに route の **存在だけを assert すると無認証 route を見逃す**: SBT の HttpApi は
 * `corsPreflight` のみで生成され `defaultAuthorizer` を持たないため、 `authorizer` を渡し忘れた
 * route は誰でも叩ける。 したがって `AuthorizationType: "JWT"` まで assert する。
 */

function synth(props?: {
  controlDataBackend?: string;
  tursoDatabaseUrl?: string;
  tursoAuthTokenParameterName?: string;
}): Template {
  const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    systemAdminEmail: "admin@example.com",
    ...props,
  });
  return Template.fromStack(stack);
}

/** `/admin/idp*` の Route resource を RouteKey 文字列で引く。 */
function idpRoutes(template: Template): Record<string, { RouteKey: string; [k: string]: unknown }> {
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  return Object.fromEntries(
    Object.entries(routes)
      .map(([id, resource]) => [id, resource.Properties] as const)
      .filter(([, properties]) => String(properties?.RouteKey ?? "").includes("/admin/idp")),
  );
}

describe("Control Plane /admin/idp API (#2941)", () => {
  it("should register every route the IdP handler serves (missing route = unmatched 404 with no CORS = Failed to fetch)", () => {
    const routeKeys = Object.values(idpRoutes(synth()))
      .map((properties) => properties.RouteKey)
      .sort();

    // routes.ts が生やす path: `/admin/idp` (list/create) と `/admin/idp/:idpId` (get/update/delete)。
    // `/admin/idp/healthz` は `{idpId}` route に吸収され Hono が raw path で再 routing する。
    expect(routeKeys).toEqual([
      "DELETE /admin/idp/{idpId}",
      "GET /admin/idp",
      "GET /admin/idp/{idpId}",
      "PATCH /admin/idp/{idpId}",
      "POST /admin/idp",
    ]);
  });

  it("should require JWT auth on every /admin/idp route (SBT's HttpApi has no defaultAuthorizer, so an omitted authorizer would publish the route)", () => {
    const routes = Object.values(idpRoutes(synth()));

    expect(routes).toHaveLength(5);
    for (const properties of routes) {
      expect(properties.AuthorizationType).toBe("JWT");
      expect(properties.AuthorizerId).toBeDefined();
    }
  });

  it("should point all /admin/idp routes at one Lambda integration (Hono routes internally)", () => {
    const integrationTargets = new Set(
      Object.values(idpRoutes(synth())).map((properties) => JSON.stringify(properties.Target)),
    );

    expect(integrationTargets.size).toBe(1);
  });

  it("should reuse the SBT control plane authorizer rather than creating a second one", () => {
    const template = synth();
    const authorizerIds = new Set(
      Object.values(idpRoutes(template)).map((properties) =>
        JSON.stringify(properties.AuthorizerId),
      ),
    );

    expect(authorizerIds.size).toBe(1);
    // SBT の `tenantsAuthorizer` 1 個だけ。 route ごとに authorizer を作ると audience/issuer が
    // ずれて admin-console の ID token が片方でだけ落ちる。
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
  });

  it("should grant the IdP Lambda Cognito identity-provider CRUD scoped to this account/region", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: [
              "cognito-idp:CreateIdentityProvider",
              "cognito-idp:UpdateIdentityProvider",
              "cognito-idp:DescribeIdentityProvider",
              "cognito-idp:DeleteIdentityProvider",
              "cognito-idp:ListIdentityProviders",
            ],
            Resource: "arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/*",
          }),
        ]),
      },
    });
  });

  it("should pass the control plane user pool id to the handler (required env — cold start throws without it)", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CONTROL_PLANE_USER_POOL_ID: Match.anyValue(),
        }),
      },
    });
  });
});

describe("Control Plane /admin/idp storage seam (#2941)", () => {
  it("should synthesize the system-scope SamlIdps table on the default (dynamodb) backend", () => {
    const template = synth();

    // CDK は PROVISIONED が CFn の default なので `BillingMode` を出力しない。 provisioned で
    // あることは `ProvisionedThroughput` の存在で pin する (= on-demand 禁止の運用方針)。
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ SAML_IDPS_TABLE_NAME: Match.anyValue() }),
      },
    });
  });

  it("should not synthesize any SamlIdps table on the pure SQL (turso) backend — standing cost stays at zero", () => {
    const template = synth({
      controlDataBackend: "turso",
      tursoDatabaseUrl: "libsql://example.turso.io",
      tursoAuthTokenParameterName: "/TenkaCloud/development/turso/auth-token",
    });

    const samlIdpTables = Object.values(template.findResources("AWS::DynamoDB::Table")).filter(
      (resource) =>
        JSON.stringify(resource.Properties?.KeySchema) ===
        JSON.stringify([
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ]),
    );

    expect(samlIdpTables).toHaveLength(0);
  });

  it("should route the turso backend through env + SSM read instead of a table", () => {
    const template = synth({
      controlDataBackend: "turso",
      tursoDatabaseUrl: "libsql://example.turso.io",
      tursoAuthTokenParameterName: "/TenkaCloud/development/turso/auth-token",
    });

    // resolveSamlIdpsRepository は table 名の有無ではなく CONTROL_DATA_BACKEND で分岐するので、
    // SAML_IDPS_TABLE_NAME 不在でも pure SQL 経路が成立する。
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CONTROL_DATA_BACKEND: "turso",
          TURSO_DATABASE_URL: "libsql://example.turso.io",
          TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/development/turso/auth-token",
        }),
      },
    });
    // `Stack.partition` は token なので Resource は `Fn::Join` で出る (ハードコードした
    // "arn:aws:..." では一致しない)。 parameter path まで含めて join の中身を pin する。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "ssm:GetParameter",
            Resource: {
              "Fn::Join": [
                "",
                [
                  "arn:",
                  { Ref: "AWS::Partition" },
                  ":ssm:ap-northeast-1:123456789012:parameter/TenkaCloud/development/turso/auth-token",
                ],
              ],
            },
          }),
        ]),
      },
    });
  });

  it("should keep the default backend byte-compatible by not injecting CONTROL_DATA_BACKEND", () => {
    const functions = synth().findResources("AWS::Lambda::Function");
    const idpFunction = Object.values(functions).find((resource) =>
      Boolean(resource.Properties?.Environment?.Variables?.CONTROL_PLANE_USER_POOL_ID),
    );

    expect(idpFunction).toBeDefined();
    expect(idpFunction?.Properties.Environment.Variables).not.toHaveProperty(
      "CONTROL_DATA_BACKEND",
    );
    expect(idpFunction?.Properties.Environment.Variables).not.toHaveProperty("TURSO_DATABASE_URL");
  });
});
