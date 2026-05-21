import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { toFriendlyError } from "../../src/lib/friendly-error";

describe("toFriendlyError", () => {
  it("should expand known backend error code (assume_role_failed) into Japanese title + cause candidates", () => {
    const err = new ApiError(
      422,
      '{"error":"assume_role_failed","underlyingErrorName":"AccessDenied"}',
    );
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/AssumeRole/);
    expect(fe.possibleCauses).toBeDefined();
    expect(fe.possibleCauses?.length).toBeGreaterThan(0);
  });

  it("should also look up mapping for known code (role_not_found)", () => {
    const err = new ApiError(404, '{"error":"role_not_found"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/IAM Role/);
  });

  it("should include status code in title but NOT emit raw JSON for unknown error codes", () => {
    const err = new ApiError(500, '{"error":"unknown_thing","message":"boom"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toContain("500");
    expect(fe.title).not.toContain("{");
    expect(fe.title).not.toContain('"error"');
  });

  it("should parse body in `API 422: ...` form (= regression case where upstream already prefixed)", () => {
    const err = new ApiError(422, 'API 422: {"error":"assume_role_failed"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/AssumeRole/);
  });

  it("should put raw text into hint when backend returns only text (= neither JSON nor an error key)", () => {
    const err = new ApiError(500, "Internal Server Error");
    const fe = toFriendlyError(err);
    expect(fe.title).toContain("500");
    expect(fe.hint).toBe("Internal Server Error");
  });

  it("should use message only as title for Error other than ApiError", () => {
    const fe = toFriendlyError(new Error("Network down"));
    expect(fe.title).toBe("Network down");
    expect(fe.possibleCauses).toBeUndefined();
  });

  it("should toString non-Error values such as strings and use as title", () => {
    const fe = toFriendlyError("plain string");
    expect(fe.title).toBe("plain string");
  });

  // Issue #948 (ADR-020 Phase B.1): granular role gate で返る forbidden_role
  it("should expand forbidden_role into a friendly title (= #948)", () => {
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
  it("should expand cannot_change_own_role into a friendly title", () => {
    const err = new ApiError(409, '{"error":"cannot_change_own_role"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/自分自身の role/);
  });

  // Issue #925 lock-out 防止 (= 自己 delete 禁止)
  it("should expand cannot_delete_self into a friendly title", () => {
    const err = new ApiError(409, '{"error":"cannot_delete_self"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/自分自身は削除/);
  });

  // Issue #950 (ADR-020 Phase D): audit table 未配線
  it("should expand audit_log_unconfigured into a friendly title (= #950)", () => {
    const err = new ApiError(503, '{"error":"audit_log_unconfigured"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/監査ログ.*未配線/);
    expect(fe.possibleCauses?.length).toBeGreaterThan(0);
  });

  // Issue #949 (ADR-020 Phase C): ControlPlane UserPool 未配線
  it("should expand control_plane_user_pool_unconfigured into a friendly title (= #949)", () => {
    const err = new ApiError(503, '{"error":"control_plane_user_pool_unconfigured"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/ControlPlane UserPool.*未配線/);
  });

  it("should expand missing_tenant_claim into a friendly title", () => {
    const err = new ApiError(401, '{"error":"missing_tenant_claim"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/tenant 識別子/);
  });

  it("should expand duplicate_user into a friendly title", () => {
    const err = new ApiError(409, '{"error":"duplicate_user","email":"alice@example.com"}');
    const fe = toFriendlyError(err);
    expect(fe.title).toMatch(/同 email/);
  });
});
