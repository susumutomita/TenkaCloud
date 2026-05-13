import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IdentityProvider } from "../lib/tenant-template/identity-provider";

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
    it("Cognito UserPool / UserPoolClient / UserPoolDomain を 1 セット作るべき", () => {
      const { template } = synth("tenant-1", "https://d123abc.cloudfront.net");
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
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
      const blocked = ["custom:tenantId", "custom:userRole", "custom:apiKey", "custom:tenantTier"];
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

    it("#529 i18n: 招待メール body に JA / EN / ES / ZH 4 言語が含まれ console URL + placeholder も embed されるべき", () => {
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      // Subject は 4 言語並列 (mail client preview での言語識別用)
      template.hasResourceProperties(
        "AWS::Cognito::UserPool",
        Match.objectLike({
          AdminCreateUserConfig: Match.objectLike({
            InviteMessageTemplate: Match.objectLike({
              EmailSubject: Match.stringLikeRegexp(
                "テナント管理コンソール招待.*Tenant Admin Invitation",
              ),
            }),
          }),
        }),
      );
      const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
      const body =
        (
          userPool?.Properties as {
            AdminCreateUserConfig?: { InviteMessageTemplate?: { EmailMessage?: string } };
          }
        )?.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "";
      // 4 言語の greeting (= operator がどの言語でも 1 段落見つけられる)
      expect(body).toContain("ようこそ TenkaCloud"); // JA
      expect(body).toContain("Welcome to TenkaCloud"); // EN
      expect(body).toContain("Bienvenido a TenkaCloud"); // ES
      expect(body).toContain("欢迎使用 TenkaCloud"); // ZH
      // Cognito placeholder と console URL
      expect(body).toContain("{username}");
      expect(body).toContain("{####}");
      expect(body).toContain(consoleUrl);
    });

    it("#660: 各 field (ユーザー名 / 一時パスワード / URL) が paragraph break (= 二重改行) で区切られるべき", () => {
      // Gmail / Outlook は単一改行を space に re-flow するので、 fields は \n\n で区切らないと
      // 1 行に潰れて読めなくなる (= PR-582 で起きた regression)。
      const consoleUrl = "https://d123abc.cloudfront.net";
      const { template } = synth("tenant-1", consoleUrl);
      const userPool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0];
      const body =
        (
          userPool?.Properties as {
            AdminCreateUserConfig?: { InviteMessageTemplate?: { EmailMessage?: string } };
          }
        )?.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "";
      // 各 field の前後に \n\n がある (= paragraph break)
      expect(body).toMatch(/\n\n■ ユーザー名: \{username\}\n\n/);
      expect(body).toMatch(/\n\n■ 一時パスワード: \{####\}\n\n/);
      expect(body).toMatch(/\n\n■ Username: \{username\}\n\n/);
      // 言語間の divider が存在する (= 視覚的セクション区切り)
      expect(body).toContain("═══");
      // 言語 prefix が各セクション冒頭にある (= 受信者が読める段落をすぐ見つけられる)
      expect(body).toContain("▼ 日本語");
      expect(body).toContain("▼ English");
      expect(body).toContain("▼ Español");
      expect(body).toContain("▼ 中文 (简体)");
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
});
