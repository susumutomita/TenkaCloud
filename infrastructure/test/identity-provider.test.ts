import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import type { SamlIdpConfig } from "../lib/config/config-interface";
import {
  buildAllowedRedirectUrls,
  buildSupportedIdentityProviders,
  IdentityProvider,
} from "../lib/tenant-template/identity-provider";

function synth(
  tenantId: string,
  applicationAdminConsoleUrl: string,
  environment = "development",
  samlConfig?: SamlIdpConfig,
): { template: Template; provider: IdentityProvider } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const provider = new IdentityProvider(stack, "Identity", {
    tenantId,
    environment,
    applicationAdminConsoleUrl,
    samlConfig,
  });
  return { template: Template.fromStack(stack), provider };
}

describe("IdentityProvider", () => {
  describe("テナント ID と applicationAdminConsoleUrl を渡してインスタンス化したとき", () => {
    it("Cognito UserPool / UserPoolClient / UserPoolDomain を 1 セット作るべき", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    });

    it("ADR-020 Phase E: tenant UserPool は MFA REQUIRED + TOTP-only に設定するべき", () => {
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

    it("UserPoolDomain prefix は TenkaCloud-{env}-{tenantId}-{accountId} を lowercase 化して使うべき", () => {
      const { template } = synth("Tenant-ABC", "https://example.cloudfront.net", "Development");
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-development-tenant-abc-123456789012",
      });
    });

    it("UserPoolDomain prefix は env が違えば別の値になるべき (dev/staging 同居対応)", () => {
      const { template: dev } = synth("pooled", "https://example.cloudfront.net", "development");
      const { template: stg } = synth("pooled", "https://example.cloudfront.net", "staging");
      dev.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-development-pooled-123456789012",
      });
      stg.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: "tenkacloud-staging-pooled-123456789012",
      });
    });

    it("UserPoolClient の callbackUrls に CloudFront URL/callback と localhost:5174/callback を含むべき", () => {
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

    it("UserPoolClient の logoutUrls に CloudFront URL/ と localhost:5174/ を含むべき", () => {
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

    it("cognitoDomainUrl を property として公開すべき (https://{prefix}.auth.{region}.amazoncognito.com 形式)", () => {
      const { provider } = synth("tenant-1", "https://example.cloudfront.net");
      expect(provider.cognitoDomainUrl).toBe(
        "https://tenkacloud-development-tenant-1-123456789012.auth.ap-northeast-1.amazoncognito.com",
      );
    });

    it("UserPoolClient の writeAttributes は custom:tenantId を含まないべき (cross-tenant rewrite 防止)", () => {
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

    it("UserPoolClient の writeAttributes は email を含むべき (ユーザは自分の email を更新できる)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const writeAttrs = Object.values(clients)[0]?.Properties?.WriteAttributes ?? [];
      expect(writeAttrs).toContain("email");
    });

    it("Issue #748: UserPool schema に custom:tenantName が含まれるべき (mutable=true、 admin 経由で書き換える)", () => {
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

    it("Issue #748: UserPoolClient の readAttributes は custom:tenantName を含むべき (id_token claim 経路)", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const readAttrs = Object.values(clients)[0]?.Properties?.ReadAttributes ?? [];
      expect(readAttrs).toContain("custom:tenantName");
    });

    it("Issue #903: 招待メール subject は英語のみであるべき (4 言語混在を廃止)", () => {
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

    it("Issue #903: 招待メール body は英語のみで、 console URL + Cognito placeholder を含むべき", () => {
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

    it("Issue #903: 各 field (Username / Temporary password / Sign-in URL) が paragraph break (= 二重改行) で区切られるべき", () => {
      // Gmail / Outlook は単一改行を space に re-flow するので、 fields は \n\n で区切らないと
      // 1 行に潰れて読めなくなる (= PR-582 で起きた regression、 Issue #903 でも継続維持)。
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
      const body =
        (
          userPool?.Properties as {
            AdminCreateUserConfig?: { InviteMessageTemplate?: { EmailMessage?: string } };
          }
        )?.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "";
      expect(body).toMatch(/\n\nUsername: \{username\}\n\n/);
      expect(body).toMatch(/\n\nTemporary password: \{####\}\n\n/);
      expect(body).toMatch(/\n\nSign-in URL: /);
    });

    it("#529: SMS message も InviteMessageTemplate 整合のため Cognito placeholder 込みで置かれるべき", () => {
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

  describe("Issue #839 follow-up: SAML IdP 連携", () => {
    const sample: SamlIdpConfig = {
      metadataUrl: "https://idp.example.com/metadata.xml",
      providerName: "AcmeSAML",
    };

    it("samlConfig 未指定なら UserPoolIdentityProvider (SAML) を作らず、 SupportedIdentityProviders は COGNITO のみ", () => {
      const { template } = synth("tenant-1", "https://app.example.com");
      template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
      template.hasResourceProperties(
        "AWS::Cognito::UserPoolClient",
        Match.objectLike({
          SupportedIdentityProviders: ["COGNITO"],
        }),
      );
    });

    it("samlConfig 指定で UserPoolIdentityProvider (SAML) を 1 個作り、 MetadataURL を埋めるべき", () => {
      const { template } = synth("tenant-1", "https://app.example.com", "development", sample);
      template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
        ProviderType: "SAML",
        ProviderName: "AcmeSAML",
        ProviderDetails: Match.objectLike({ MetadataURL: "https://idp.example.com/metadata.xml" }),
      });
    });

    it("並列 (= enforceSamlOnly=false default) では UserPoolClient.SupportedIdentityProviders に COGNITO + SAML 両方が乗るべき", () => {
      // CDK L2 の UserPoolClientIdentityProvider.custom は CFn Ref で IdP リソースを参照する
      // (= 文字列リテラルではなく Ref オブジェクトとして埋まる)。 実 deploy では Ref が
      // ProviderName 文字列に解決されるが、 test では Ref shape で assertion する必要がある。
      const { template } = synth("tenant-1", "https://app.example.com", "development", sample);
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const idps = (Object.values(clients)[0]?.Properties?.SupportedIdentityProviders ??
        []) as unknown[];
      expect(idps).toContain("COGNITO");
      // SAML 側は { Ref: "...SamlIdp..." } の shape で入る
      const samlEntry = idps.find((e) => typeof e === "object" && e !== null && "Ref" in e) as
        | { Ref?: string }
        | undefined;
      expect(samlEntry?.Ref).toMatch(/SamlIdp/);
    });

    it("enforceSamlOnly=true なら SupportedIdentityProviders は SAML 単独 + ExplicitAuthFlows から password / SRP が消えるべき", () => {
      const { template } = synth("tenant-1", "https://app.example.com", "development", {
        ...sample,
        enforceSamlOnly: true,
      });
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const props = Object.values(clients)[0]?.Properties ?? {};
      const idps = (props.SupportedIdentityProviders ?? []) as unknown[];
      // COGNITO が完全に消え、 SAML provider (Ref) だけが残る
      expect(idps).not.toContain("COGNITO");
      expect(idps).toHaveLength(1);
      const samlEntry = idps[0] as { Ref?: string };
      expect(samlEntry?.Ref).toMatch(/SamlIdp/);
      // ExplicitAuthFlows から password / SRP が消える
      const flows = (props.ExplicitAuthFlows ?? []) as string[];
      expect(flows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
      expect(flows).not.toContain("ALLOW_USER_SRP_AUTH");
    });

    it("attributeMapping は default で SAML emailaddress claim を email にマップする", () => {
      const { template } = synth("tenant-1", "https://app.example.com", "development", sample);
      template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
        AttributeMapping: Match.objectLike({
          email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
        }),
      });
    });

    it("attributeMapping を override すれば caller の値が優先されるべき (= Entra ID 等の非標準 claim 対応)", () => {
      const { template } = synth("tenant-1", "https://app.example.com", "development", {
        ...sample,
        attributeMapping: { email: "urn:custom:user/email" },
      });
      template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
        AttributeMapping: Match.objectLike({ email: "urn:custom:user/email" }),
      });
    });

    it("providerName 未指定なら default `CompanySAML` を使うべき", () => {
      const { template } = synth("tenant-1", "https://app.example.com", "development", {
        metadataUrl: "https://idp.example.com/metadata.xml",
      });
      template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
        ProviderName: "CompanySAML",
      });
    });
  });
});

describe("buildSupportedIdentityProviders (pure helper)", () => {
  it("cognito=true / saml 無し → COGNITO 1 個", () => {
    const r = buildSupportedIdentityProviders({ cognito: true });
    expect(r.map((p) => p.name)).toEqual(["COGNITO"]);
  });

  it("cognito=true / saml 有り → COGNITO + 指定 SAML provider name", () => {
    const r = buildSupportedIdentityProviders({
      cognito: true,
      saml: { providerName: "AcmeSAML" },
    });
    expect(r.map((p) => p.name)).toEqual(["COGNITO", "AcmeSAML"]);
  });

  it("cognito=false / saml 有り → SAML 単独 (= SAML-only enforcement)", () => {
    const r = buildSupportedIdentityProviders({
      cognito: false,
      saml: { providerName: "AcmeSAML" },
    });
    expect(r.map((p) => p.name)).toEqual(["AcmeSAML"]);
  });

  it("cognito=false / saml 無し (= 想定外 input) は COGNITO fallback (= safe default)", () => {
    const r = buildSupportedIdentityProviders({ cognito: false });
    expect(r.map((p) => p.name)).toEqual(["COGNITO"]);
  });
});

describe("buildAllowedRedirectUrls (Issue #861)", () => {
  it("development では primary + dev localhost を返すべき", () => {
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

  it("production env では CallbackURLs に localhost が含まれないべき", () => {
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
    expect(logouts).toEqual(["https://app.example.com/"]);
  });
});
