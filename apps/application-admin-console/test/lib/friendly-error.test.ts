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
});
