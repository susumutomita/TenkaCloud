import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { toFriendlyError } from "../../src/lib/friendly-error";

describe("toFriendlyError", () => {
  it("既知の backend error code (assume_role_failed) を日本語タイトル + 原因候補に展開すべき", () => {
    const err = new ApiError(
      422,
      '{"error":"assume_role_failed","underlyingErrorName":"AccessDenied"}',
    );
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/AssumeRole/);
    expect(fe.possibleCauses).toBeDefined();
    expect(fe.possibleCauses?.length).toBeGreaterThan(0);
  });

  it("既知 code (role_not_found) も mapping を引くべき", () => {
    const err = new ApiError(404, '{"error":"role_not_found"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/IAM Role/);
  });

  it("未知の error code は title に status code を含み、 raw JSON を出さないべき", () => {
    const err = new ApiError(500, '{"error":"unknown_thing","message":"boom"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toContain("500");
    expect(fe.title).not.toContain("{");
    expect(fe.title).not.toContain('"error"');
  });

  it("body が `API 422: ...` 形 (= upstream で既に prefix されていた regression case) でも解析できるべき", () => {
    const err = new ApiError(422, 'API 422: {"error":"assume_role_failed"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/AssumeRole/);
  });

  it("backend が text のみ返した場合は raw text を hint に置くべき (= JSON でも error key も無い)", () => {
    const err = new ApiError(500, "Internal Server Error");
    const fe = toFriendlyError(err);
    expect(fe.title).toContain("500");
    expect(fe.hint).toBe("Internal Server Error");
  });

  it("ApiError 以外の Error は message のみを title にすべき", () => {
    const fe = toFriendlyError(new Error("Network down"));
    expect(fe.title).toBe("Network down");
    expect(fe.possibleCauses).toBeUndefined();
  });

  it("string 等の non-Error も toString して title にすべき", () => {
    const fe = toFriendlyError("plain string");
    expect(fe.title).toBe("plain string");
  });

  // Issue #948 (ADR-020 Phase B.1): granular role gate で返る forbidden_role
  it("forbidden_role を friendly title に展開すべき (= #948)", () => {
    const err = new ApiError(
      403,
      '{"error":"forbidden_role","message":"あなたの tenant role ではこの操作を実行できません"}',
    );
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/より高い tenant role/);
    expect(fe.hint).toMatch(/TenantAdmin に依頼/);
    expect(fe.possibleCauses?.length).toBeGreaterThan(0);
  });

  // Issue #17 lock-out 防止 (= 自己 role 変更禁止)
  it("cannot_change_own_role を friendly title に展開すべき", () => {
    const err = new ApiError(409, '{"error":"cannot_change_own_role"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/自分自身の role/);
  });

  // Issue #925 lock-out 防止 (= 自己 delete 禁止)
  it("cannot_delete_self を friendly title に展開すべき", () => {
    const err = new ApiError(409, '{"error":"cannot_delete_self"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/自分自身は削除/);
  });

  // Issue #950 (ADR-020 Phase D): audit table 未配線
  it("audit_log_unconfigured を friendly title に展開すべき (= #950)", () => {
    const err = new ApiError(503, '{"error":"audit_log_unconfigured"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/監査ログ.*未配線/);
    expect(fe.possibleCauses?.length).toBeGreaterThan(0);
  });

  // Issue #949 (ADR-020 Phase C): ControlPlane UserPool 未配線
  it("control_plane_user_pool_unconfigured を friendly title に展開すべき (= #949)", () => {
    const err = new ApiError(503, '{"error":"control_plane_user_pool_unconfigured"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/ControlPlane UserPool.*未配線/);
  });

  it("missing_tenant_claim を friendly title に展開すべき", () => {
    const err = new ApiError(401, '{"error":"missing_tenant_claim"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/tenant 識別子/);
  });

  it("duplicate_user を friendly title に展開すべき", () => {
    const err = new ApiError(409, '{"error":"duplicate_user","email":"alice@example.com"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/同 email/);
  });
});
