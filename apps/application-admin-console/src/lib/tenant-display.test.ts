import { describe, expect, it } from "vitest";
import { resolveTenantDisplayName } from "./tenant-display";

describe("resolveTenantDisplayName (Issue #830)", () => {
  it("should return custom:tenantName as-is when it is a non-empty string", () => {
    const res = resolveTenantDisplayName({ "custom:tenantName": "Acme" });
    expect(res).toEqual({ displayName: "Acme", fromFallback: false });
  });

  it("should trim leading and trailing whitespace (= guards Cognito attribute trailing-space drift)", () => {
    const res = resolveTenantDisplayName({ "custom:tenantName": "  Acme  " });
    expect(res.displayName).toBe("Acme");
    expect(res.fromFallback).toBe(false);
  });

  it("should return displayName=null + fromFallback=true when custom:tenantName is undefined", () => {
    const res = resolveTenantDisplayName({});
    expect(res).toEqual({ displayName: null, fromFallback: true });
  });

  it("should set fromFallback=true when custom:tenantName is empty or whitespace-only (= do not surface UUID-like tenantId in welcome)", () => {
    expect(resolveTenantDisplayName({ "custom:tenantName": "" })).toEqual({
      displayName: null,
      fromFallback: true,
    });
    expect(resolveTenantDisplayName({ "custom:tenantName": "   " })).toEqual({
      displayName: null,
      fromFallback: true,
    });
  });

  it("should set fromFallback=true when claims itself is null (= unauthenticated / token decode failure)", () => {
    expect(resolveTenantDisplayName(null)).toEqual({ displayName: null, fromFallback: true });
  });

  it("should NOT leak a UUID v4-shaped tenantId into the welcome when tenantName is missing (= primary regression guard)", () => {
    const claims = {
      "custom:tenantId": "3f01a734-9652-4065-a391-fa1b4d45ae26",
      "custom:tenantName": undefined,
    };
    expect(resolveTenantDisplayName(claims).displayName).toBeNull();
  });
});
