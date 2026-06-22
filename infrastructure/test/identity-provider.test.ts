import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  buildAllowedRedirectUrls,
  IdentityProvider,
} from "../lib/tenant-template/identity-provider";

function synth(
  tenantId: string,
  applicationAdminConsoleUrl: string,
  environment = "development",
): { template: Template; provider: IdentityProvider } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const provider = new IdentityProvider(stack, "Identity", {
    tenantId,
    environment,
    applicationAdminConsoleUrl,
  });
  return { template: Template.fromStack(stack), provider };
}

describe("IdentityProvider", () => {
  describe("テナント ID と applicationAdminConsoleUrl を渡してインスタンス化したとき", () => {
    it("should create 1 set of Cognito UserPool / UserPoolClient / UserPoolDomain", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    });

    it("should attach the branded Hosted UI CSS (design import: Cognito Hosted UI.html)", () => {
      // テナント Hosted UI を cognito-hosted-ui.css でブランディングする (ink 背景 / Summit
      // ロゴ banner / paper card / ink submit)。 ロゴ画像は CFn では設定できないため別途アップロード。
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.resourceCountIs("AWS::Cognito::UserPoolUICustomizationAttachment", 1);
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolUICustomizationAttachment",
        Match.objectLike({
          CSS: Match.stringLikeRegexp("background-customizable"),
        }),
      );
    });

    it("ADR-020 Phase E: should configure tenant UserPool with MFA REQUIRED + TOTP-only", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      // MFA を REQUIRED にし、 SMS を無効化、 TOTP (SOFTWARE_TOKEN_MFA) のみ許可。
      // destructive 操作を扱う tenant admin console の baseline (OPTIONAL は不可)。
      template.hasResourceProperties(
        "AWS::Cognito::UserPool",
        Match.objectLike({
          MfaConfiguration: "ON",
          EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
        }),
      );
    });

    it("Issue #1696: should harden the tenant UserPoolClient session (60min access/id, 1day refresh, revocation on)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      // CDK の L2 UserPoolClient は token validity を CFn 上すべて minutes に正規化する
      // (= refresh 1 day → 1440 min)。 値は機能的に 60min / 60min / 1day で正しい。
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          AccessTokenValidity: 60,
          IdTokenValidity: 60,
          RefreshTokenValidity: 1440,
          TokenValidityUnits: {
            AccessToken: "minutes",
            IdToken: "minutes",
            RefreshToken: "minutes",
          },
          EnableTokenRevocation: true,
        }),
      );
    });

    it("UserPoolDomain prefix should use lowercased TenkaCloud-{env}-{tenantId}-{accountId}", () => {
      const { template } = synth("Tenant-ABC", "https://example.cloudfront.net", "Development");
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-development-tenant-abc-123456789012",
      });
    });

    it("UserPoolDomain prefix should differ per env (dev/staging coexistence)", () => {
      const { template: dev } = synth("pooled", "https://example.cloudfront.net", "development");
      const { template: stg } = synth("pooled", "https://example.cloudfront.net", "staging");
      dev.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-development-pooled-123456789012",
      });
      stg.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-staging-pooled-123456789012",
      });
    });

    it("UserPoolClient callbackUrls should include CloudFront URL/callback and localhost:5174/callback", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          CallbackURLs: Match.arrayWith([
            "https://d123abc.cloudfront.net/callback",
            "http://localhost:5174/callback",
          ]),
        }),
      );
    });

    it("UserPoolClient logoutUrls should include CloudFront URL/ and localhost:5174/", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          LogoutURLs: Match.arrayWith([
            "https://d123abc.cloudfront.net/",
            "http://localhost:5174/",
          ]),
        }),
      );
    });

    it("UserPoolClient logoutUrls should also include /login (matching beginLogout's logout_uri)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          LogoutURLs: Match.arrayWith([
            "https://d123abc.cloudfront.net/login",
            "http://localhost:5174/login",
          ]),
        }),
      );
    });

    it("should expose cognitoDomainUrl as a property (https://{prefix}.auth.{region}.amazoncognito.com form)", () => {
      const { provider } = synth("tenant-1", "https://example.cloudfront.net");
      expect(provider.cognitoDomainUrl).toBe(
        "https://tenkacloud-development-tenant-1-123456789012.auth.ap-northeast-1.amazoncognito.com",
      );
    });

    it("UserPoolClient writeAttributes should not include custom:tenantId (cross-tenant rewrite guard)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const writeAttrs = Object.values(clients)[0]?.Properties?.WriteAttributes ?? [];
      const blocked = [
        "custom:tenantId",
        "custom:userRole",
        "custom:apiKey",
        "custom:tenantTier",
        // Issue #748: tenant 名も tenant user 自身に書き換えさせない (cross-tenant 改名防止)
        "custom:tenantName",
      ];
      for (const attr of blocked) {
        expect(writeAttrs).not.toContain(attr);
      }
    });

    it("UserPoolClient writeAttributes should include email (users can update their own email)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const writeAttrs = Object.values(clients)[0]?.Properties?.WriteAttributes ?? [];
      expect(writeAttrs).toContain("email");
    });

    it("Issue #748: UserPool schema should include custom:tenantName (mutable=true, rewritten via admin)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.hasResourceProperties(
        "AWS::Cognito::UserPool",
        Match.objectLike({
          Schema: Match.arrayWith([
            Match.objectLike({
              Name: "tenantName",
              AttributeDataType: "String",
              Mutable: true,
            }),
          ]),
        }),
      );
    });

    it("Issue #748: UserPoolClient readAttributes should include custom:tenantName (id_token claim path)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const readAttrs = Object.values(clients)[0]?.Properties?.ReadAttributes ?? [];
      expect(readAttrs).toContain("custom:tenantName");
    });

    it("Issue #903: invitation email subject should be English-only (no more 4-language mix)", () => {
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      template.hasResourceProperties(
        "AWS::Cognito::UserPool",
        Match.objectLike({
          AdminCreateUserConfig: Match.objectLike({
            InviteMessageTemplate: Match.objectLike({
              EmailSubject: "[TenkaCloud] Tenant Admin Invitation",
            }),
          }),
        }),
      );
    });

    it("Issue #903: invitation email body should be English-only and include console URL + Cognito placeholder", () => {
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
      const body =
        (
          userPool?.Properties as {
            AdminCreateUserConfig?: { InviteMessageTemplate?: { EmailMessage?: string } };
          }
        )?.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "";
      // 英語 greeting + 各 field
      expect(body).toContain("Welcome to TenkaCloud");
      expect(body).toContain("Username:");
      expect(body).toContain("Temporary password:");
      expect(body).toContain("Sign-in URL:");
      // 旧 4 言語混在の痕跡が無いこと (= regression 防止)
      expect(body).not.toContain("ようこそ TenkaCloud");
      expect(body).not.toContain("Bienvenido a TenkaCloud");
      expect(body).not.toContain("欢迎使用 TenkaCloud");
      expect(body).not.toContain("▼");
      // Cognito placeholder と console URL
      expect(body).toContain("{username}");
      expect(body).toContain("{####}");
      expect(body).toContain(consoleUrl);
    });

    it("should separate fields with HTML <br> breaks (Cognito sends the invite as HTML, so \\n collapses)", () => {
      // Cognito は招待メールを HTML 配信するため `\n` は Gmail / Outlook で space に collapse され、
      // 全文が 1 行に潰れて読めなくなる (実機確認)。 改行は <br>、 段落間は <br><br> でないといけない。
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
      const body =
        (
          userPool?.Properties as {
            AdminCreateUserConfig?: { InviteMessageTemplate?: { EmailMessage?: string } };
          }
        )?.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "";
      // credentials block: paragraph break before, single <br> between each line
      expect(body).toContain(
        "<br><br>Username: {username}<br>Temporary password: {####}<br>Sign-in URL: ",
      );
      // no raw newlines survive (would collapse in HTML mail → the run-on-paragraph bug)
      expect(body).not.toContain("\n");
    });

    it("#529: should set the SMS message with Cognito placeholders to stay consistent with InviteMessageTemplate", () => {
      // Cognito CFn は InviteMessageTemplate 設定時に SMSMessage の placeholder 整合性を
      // check する (aws-cdk#30315 系)。SMS は使わないが空にできないので最短形で配置。
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.hasResourceProperties(
        "AWS::Cognito::UserPool",
        Match.objectLike({
          AdminCreateUserConfig: Match.objectLike({
            InviteMessageTemplate: Match.objectLike({
              SMSMessage: Match.stringLikeRegexp(".*\\{username\\}.*"),
            }),
          }),
        }),
      );
    });
  });

  describe("Issue #1066: SAML IdP 連携は廃止 (= MFA 必須化 #1035 で代替)", () => {
    it("should not create UserPoolIdentityProvider (SAML)", () => {
      const { template } = synth("tenant-1", "https://app.example.com");
      template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    });

    it("UserPoolClient SupportedIdentityProviders should be COGNITO only", () => {
      const { template } = synth("tenant-1", "https://app.example.com");
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          SupportedIdentityProviders: ["COGNITO"],
        }),
      );
    });
  });
});

describe("buildAllowedRedirectUrls (Issue #861)", () => {
  it("should return primary + dev localhost in development", () => {
    expect(
      buildAllowedRedirectUrls(
        "https://app.example.com/callback",
        "development",
        "http://localhost:5174/callback",
      ),
    ).toEqual(["https://app.example.com/callback", "http://localhost:5174/callback"]);
  });

  it("staging も localhost を含めて debug 経路を維持", () => {
    expect(
      buildAllowedRedirectUrls(
        "https://app.example.com/callback",
        "staging",
        "http://localhost:5174/callback",
      ),
    ).toEqual(["https://app.example.com/callback", "http://localhost:5174/callback"]);
  });

  it("production は localhost を含めない (= phishing 経路の attack surface 縮減)", () => {
    expect(
      buildAllowedRedirectUrls(
        "https://app.example.com/callback",
        "production",
        "http://localhost:5174/callback",
      ),
    ).toEqual(["https://app.example.com/callback"]);
  });

  it("environment の casing は無視 (= Production / PRODUCTION も同等)", () => {
    expect(
      buildAllowedRedirectUrls("https://app.example.com/", "PRODUCTION", "http://localhost:5174/"),
    ).toEqual(["https://app.example.com/"]);
  });
});

describe("OAuth flow hardening (Issue #861)", () => {
  function synthFor(environment: string): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    new IdentityProvider(stack, "Identity", {
      tenantId: "tenant-1",
      environment,
      applicationAdminConsoleUrl: "https://app.example.com",
    });
    return Template.fromStack(stack);
  }

  it("UserPoolClient で implicitCodeGrant が無効 (= ALLOW_FLOWS に implicit が含まれない)", () => {
    const template = synthFor("development");
    template.hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      Match.objectLike({
        AllowedOAuthFlows: Match.arrayWith(["code"]),
      }),
    );
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const flows = (Object.values(clients)[0]?.Properties?.AllowedOAuthFlows ?? []) as string[];
    expect(flows).not.toContain("implicit");
  });

  it("CallbackURLs should not include localhost in production env", () => {
    const template = synthFor("production");
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const callbacks = (Object.values(clients)[0]?.Properties?.CallbackURLs ?? []) as string[];
    expect(callbacks).toEqual(["https://app.example.com/callback"]);
    expect(callbacks).not.toContain("http://localhost:5174/callback");
  });

  it("development env では CallbackURLs に localhost が含まれる (= dev 経路維持)", () => {
    const template = synthFor("development");
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const callbacks = (Object.values(clients)[0]?.Properties?.CallbackURLs ?? []) as string[];
    expect(callbacks).toContain("http://localhost:5174/callback");
  });

  it("production env では LogoutURLs に localhost が含まれない", () => {
    const template = synthFor("production");
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const logouts = (Object.values(clients)[0]?.Properties?.LogoutURLs ?? []) as string[];
    // \`/login\` も Cognito の logout_uri 一致用に追加されている (= production でも localhost 無し)。
    expect(logouts).toEqual(["https://app.example.com/", "https://app.example.com/login"]);
  });
});
