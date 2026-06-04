import { describe, expect, it } from "vitest";
import { buildInviteEmailBody, INVITE_EMAIL_SUBJECT } from "../lib/control-plane/invite-message";

/**
 * Issue #653 / #714: SBT default の SystemAdmin 招待メール本文 (`http://localhost` を埋める)
 * を override する pure function の挙動を pin。 #714 で English-only に揃え、 ja セクションは
 * drop。 stack 統合は cdk synth 経路で確認する。
 */
describe("buildInviteEmailBody (Issue #714 English-only)", () => {
  it("should embed the CloudFront URL in the body once the admin-console origin is resolved", () => {
    const body = buildInviteEmailBody("https://d1234abc.cloudfront.net");
    expect(body).toContain("https://d1234abc.cloudfront.net");
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("should return an English fallback prompting operator contact when origin is undetermined (Phase 1 deploy)", () => {
    const body = buildInviteEmailBody(undefined);
    expect(body).toMatch(/contact your operator/i);
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("should treat empty string as fallback too (equivalent to unset env)", () => {
    const body = buildInviteEmailBody("");
    expect(body).toMatch(/contact your operator/i);
  });

  it("should preserve Cognito placeholders ({username} / {####}) in the body", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("{username}");
    expect(body).toContain("{####}");
  });

  it("should keep to English-only without any Japanese section (#714)", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("Welcome to TenkaCloud Admin Console");
    expect(body).not.toMatch(/へようこそ/);
    expect(body).not.toMatch(/ユーザー名/);
    expect(body).not.toMatch(/仮パスワード/);
    expect(body).not.toMatch(/運営にお問い合わせください/);
  });

  it("subject should also be English-only and overridden with the TenkaCloud name", () => {
    expect(INVITE_EMAIL_SUBJECT).toMatch(/TenkaCloud Admin Console/);
    expect(INVITE_EMAIL_SUBJECT).not.toMatch(/control plane/i);
    expect(INVITE_EMAIL_SUBJECT).not.toMatch(/招待/);
  });

  it("the URL should appear in the body exactly once (drop legacy ja+en duplication)", () => {
    const body = buildInviteEmailBody("https://d999.cloudfront.net");
    const matches = body.match(/https:\/\/d999\.cloudfront\.net/g);
    expect(matches).toHaveLength(1);
  });

  it("should separate sections with HTML <br> breaks (Cognito sends the invite as HTML, so \\n collapses)", () => {
    const body = buildInviteEmailBody("https://example.com");
    // Cognito は HTML 配信なので `\n` は 1 行に collapse される。 段落間は <br><br>、 raw \n は無し。
    expect(body).toContain("<br><br>");
    expect(body).not.toContain("\n");
    expect(body.startsWith("Welcome to TenkaCloud Admin Console.")).toBe(true);
  });
});
