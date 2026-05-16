import { describe, expect, it } from "vitest";
import { resolveTenantDisplayName } from "./tenant-display";

describe("resolveTenantDisplayName (Issue #830)", () => {
  it("custom:tenantName が非空文字列なら そのまま返すべき", () => {
    const res = resolveTenantDisplayName({ "custom:tenantName": "Acme" });
    expect(res).toEqual({ displayName: "Acme", fromFallback: false });
  });

  it("前後の空白は trim すべき (= Cognito attribute の trailing space 揺れ対策)", () => {
    const res = resolveTenantDisplayName({ "custom:tenantName": "  Acme  " });
    expect(res.displayName).toBe("Acme");
    expect(res.fromFallback).toBe(false);
  });

  it("custom:tenantName が undefined なら displayName=null + fromFallback=true", () => {
    const res = resolveTenantDisplayName({});
    expect(res).toEqual({ displayName: null, fromFallback: true });
  });

  it("custom:tenantName が空文字 / 空白のみなら fromFallback=true (= UUID-like tenantId を welcome に出さない)", () => {
    expect(resolveTenantDisplayName({ "custom:tenantName": "" })).toEqual({
      displayName: null,
      fromFallback: true,
    });
    expect(resolveTenantDisplayName({ "custom:tenantName": "   " })).toEqual({
      displayName: null,
      fromFallback: true,
    });
  });

  it("claims 自体が null (= 未認証 / token decode 失敗) なら fromFallback=true", () => {
    expect(resolveTenantDisplayName(null)).toEqual({ displayName: null, fromFallback: true });
  });

  it("UUID v4 形状の tenantId が tenantName 欠落時に welcome に漏れないこと (= 主要回帰防止)", () => {
    const claims = {
      "custom:tenantId": "3f01a734-9652-4065-a391-fa1b4d45ae26",
      "custom:tenantName": undefined,
    };
    expect(resolveTenantDisplayName(claims).displayName).toBeNull();
  });
});
