import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY } from "../../lib/app-config/index";
import { buildAppPlaneCore } from "../../lib/app-plane-core/index";

/**
 * Issue #2953: human TenantAPI authorizer で access token を弾く。
 *
 * `COGNITO_USER_POOLS` authorizer の `identityValidationExpression` は受信 token の `aud` claim を
 * 正規表現に照合する。Cognito の ID token は `aud` に app client id を持ち、access token は `aud`
 * を持たない (代わりに `client_id`)。よって human の app client id を pin すれば access token は
 * gateway 段で 401 になる。
 *
 * 稼働中 authorizer の UPDATE なので **既定 OFF**。この test が守るのは
 *  1. OFF のとき property を一切書かない (= 既存 tenant の CFn 物理差分 0 件)
 *  2. ON のとき human の app client id に固定される (= 空文字 `^$` のような ID token 全落ちの
 *     式が紛れ込まない)
 *  3. SPA 3 call site が ID token を送り続けている (= pin する対象が正しい)
 * である。
 */

function synth(features?: Readonly<Record<string, boolean>>): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const makeStubLambda = (id: string) =>
    new LambdaFunction(stack, id, {
      runtime: Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: Code.fromInline("exports.handler = async () => ({});"),
    });
  buildAppPlaneCore(stack, {
    tenantId: "tenant-1",
    tenantName: "Tenant 1",
    environment: "development",
    isPooledDeploy: false,
    deployApiLambda: makeStubLambda("DeployApi"),
    eventApiLambda: makeStubLambda("EventApi"),
    competitorAccountsApiLambda: makeStubLambda("CompetitorAccountsApi"),
    samlIdps: [],
    samlAdminAllowlist: [],
    ...(features ? { features } : {}),
    apiKeyConfig: {
      ssmParameterNames: {
        basic: { keyId: "b", value: "b" },
        standard: { keyId: "s", value: "s" },
        premium: { keyId: "p", value: "p" },
        platinum: { keyId: "pl", value: "pl" },
      },
      ssmLookup: (name: string) => name,
    },
  });
  return Template.fromStack(stack);
}

type CfnResource = { readonly Properties?: Record<string, unknown> };

function authorizers(template: Template): CfnResource[] {
  return Object.values(template.findResources("AWS::ApiGateway::Authorizer")) as CfnResource[];
}

describe("#2953: identityValidationExpression is opt-in", () => {
  it("should not write the property at all when the flag is off (existing tenants stay byte-identical)", () => {
    const found = authorizers(synth());
    expect(found.length).toBeGreaterThan(0);
    for (const authorizer of found) {
      expect(authorizer.Properties?.IdentityValidationExpression).toBeUndefined();
    }
  });

  it("should pin the human app client id when the flag is on", () => {
    const template = synth({ [HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY]: true });
    const found = authorizers(template);
    expect(found.length).toBe(1);
    const expression = found[0]?.Properties?.IdentityValidationExpression;
    // `Fn::Join` で `^<Ref clientId>$` になる。Ref が入っていること、そして式が
    // ID token を全部落とす `^$` ではないことを確認する。
    const serialized = JSON.stringify(expression);
    expect(serialized).toContain("^");
    expect(serialized).toContain("$");
    expect(serialized).toContain("Ref");
    expect(expression).not.toBe("^$");
  });

  it("should keep every method on the human API free of AuthorizationScopes even with the flag on", () => {
    const template = synth({ [HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY]: true });
    const methods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    ) as CfnResource[];
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(method.Properties?.AuthorizationScopes).toBeUndefined();
    }
  });
});

describe("#2953: the console keeps sending an ID token", () => {
  it.each([
    "apps/application-admin-console/src/api/client.ts",
    "apps/application-admin-console/src/api/audit-log-client.ts",
    "apps/application-admin-console/src/api/idp-client.ts",
  ])("should authenticate %s with an ID token, not an access token", (relativePath) => {
    const source = readFileSync(
      fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
      "utf8",
    );
    expect(source).toContain("idToken");
    // access token を掴んで Bearer に載せる call site が生えたらここで落ちる (= `aud` 照合を
    // 有効にした瞬間にその画面だけ 401 になる、という発見しにくい壊れ方を先に防ぐ)。
    expect(source).not.toMatch(/Bearer \$\{accessToken\}/);
  });
});
