import { describe, expect, it } from "vitest";
import { buildInviteEmailBody, INVITE_EMAIL_SUBJECT } from "../lib/control-plane/invite-message";

/**
 * Issue #653 / #714: SBT default の SystemAdmin 招待メール本文 (`http://localhost` を埋める)
 * を override する pure function の挙動を pin。 #714 で English-only に揃え、 ja セクションは
 * drop。 stack 統合は cdk synth 経路で確認する。
 */
describe("buildInviteEmailBody (Issue #714 English-only)", () => {
  it("admin-console origin が解決済なら CloudFront URL を本文に埋めるべき", () => {
    const body = buildInviteEmailBody("https://d1234abc.cloudfront.net");
    expect(body).toContain("https://d1234abc.cloudfront.net");
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("origin 未確定 (= Phase 1 deploy) は operator 連絡を促す英語 fallback を返すべき", () => {
    const body = buildInviteEmailBody(undefined);
    expect(body).toMatch(/contact your operator/i);
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("空文字列も fallback 扱いとすべき (= env 未設定と同等)", () => {
    const body = buildInviteEmailBody("");
    expect(body).toMatch(/contact your operator/i);
  });

  it("Cognito placeholder ({username} / {####}) を本文に保持すべき", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("{username}");
    expect(body).toContain("{####}");
  });

  it("English-only に揃え、 日本語セクションは含めないべき (#714)", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("Welcome to TenkaCloud Admin Console");
    expect(body).not.toMatch(/へようこそ/);
    expect(body).not.toMatch(/ユーザー名/);
    expect(body).not.toMatch(/仮パスワード/);
    expect(body).not.toMatch(/運営にお問い合わせください/);
  });

  it("subject も英語のみで TenkaCloud 名称に上書きされているべき", () => {
    expect(INVITE_EMAIL_SUBJECT).toMatch(/TenkaCloud Admin Console/);
    expect(INVITE_EMAIL_SUBJECT).not.toMatch(/control plane/i);
    expect(INVITE_EMAIL_SUBJECT).not.toMatch(/招待/);
  });

  it("URL は body に 1 度だけ出現するべき (= 旧 ja+en 重複を排除)", () => {
    const body = buildInviteEmailBody("https://d999.cloudfront.net");
    const matches = body.match(/https:\/\/d999\.cloudfront\.net/g);
    expect(matches).toHaveLength(1);
  });

  it("各セクションを空行で分離し、 改行 collapse 耐性のある形にすべき (#714)", () => {
    const body = buildInviteEmailBody("https://example.com");
    // 空行が body に最低 1 つあり、 welcome / key:value block / next step instruction が分離される
    expect(body).toMatch(/\n\n/);
    expect(body.startsWith("Welcome to TenkaCloud Admin Console.")).toBe(true);
  });
});
