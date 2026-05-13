import { describe, expect, it } from "vitest";
import { buildInviteEmailBody, INVITE_EMAIL_SUBJECT } from "../lib/control-plane/invite-message";

/**
 * Issue #653: SBT default の SystemAdmin 招待メール本文 (`http://localhost` を埋める)
 * を override する pure function の挙動を pin。 stack 統合は cdk synth 経路で確認する
 * (= Docker bundling 不要なら synth test、 必要なら e2e で確認)。
 */
describe("buildInviteEmailBody (Issue #653)", () => {
  it("admin-console origin が解決済なら CloudFront URL を本文に埋めるべき", () => {
    const body = buildInviteEmailBody("https://d1234abc.cloudfront.net");
    expect(body).toContain("https://d1234abc.cloudfront.net");
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("origin 未確定 (= Phase 1 deploy) は運営連絡先を促す fallback 文面を返すべき", () => {
    const body = buildInviteEmailBody(undefined);
    expect(body).toContain("運営にお問い合わせください");
    expect(body).not.toMatch(/http:\/\/localhost/);
  });

  it("空文字列も fallback 扱いとすべき (= env 未設定と同等)", () => {
    const body = buildInviteEmailBody("");
    expect(body).toContain("運営にお問い合わせください");
  });

  it("Cognito placeholder ({username} / {####}) を本文に保持すべき", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("{username}");
    expect(body).toContain("{####}");
  });

  it("ja / en の両方を 1 通に並列で含めるべき (PR-582 同方針)", () => {
    const body = buildInviteEmailBody("https://example.com");
    expect(body).toContain("TenkaCloud Admin Console へようこそ");
    expect(body).toContain("Welcome to TenkaCloud Admin Console");
  });

  it("subject が TenkaCloud 名称に上書きされているべき", () => {
    expect(INVITE_EMAIL_SUBJECT).toMatch(/TenkaCloud Admin Console/);
    expect(INVITE_EMAIL_SUBJECT).not.toMatch(/control plane/i);
  });

  it("URL が body に 2 度出現すべき (= ja / en パートそれぞれ)", () => {
    const body = buildInviteEmailBody("https://d999.cloudfront.net");
    const matches = body.match(/https:\/\/d999\.cloudfront\.net/g);
    expect(matches).toHaveLength(2);
  });
});
