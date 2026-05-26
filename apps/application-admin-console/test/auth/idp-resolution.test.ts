import { describe, expect, it } from "vitest";
import { distinctProviders, emailDomain, resolveIdp } from "../../src/auth/idp-resolution";

/**
 * Issue #1340 Phase 2: per-tenant Home Realm Discovery pure-function logic。 Phase 1 (admin-console)
 * の同名テストを Application Plane に移植して並列に pinning する (= 両 SPA で挙動 drift が起きない
 * よう同じ仕様を 2 箇所で固定)。
 */
describe("emailDomain (#1340)", () => {
  it("should return the lowercased domain", () => {
    expect(emailDomain("Alice@Example.COM")).toBe("example.com");
  });

  it("should return undefined when there is no @", () => {
    expect(emailDomain("alice")).toBeUndefined();
  });

  it("should return undefined when domain part is empty", () => {
    expect(emailDomain("alice@")).toBeUndefined();
  });
});

describe("distinctProviders (#1340)", () => {
  it("should return [] for an empty directory", () => {
    expect(distinctProviders({})).toEqual([]);
  });

  it("should dedupe providers across multiple domains", () => {
    const out = distinctProviders({
      "a.com": ["corp-entra"],
      "b.com": ["corp-entra", "corp-okta"],
    });
    expect(new Set(out)).toEqual(new Set(["corp-entra", "corp-okta"]));
  });
});

describe("resolveIdp (#1340)", () => {
  it("should resolve `local` when the email has no matching domain", () => {
    expect(resolveIdp("alice@nope.com", { "example.com": ["corp-entra"] })).toEqual({
      kind: "local",
    });
  });

  it("should auto-redirect when exactly one provider serves the domain", () => {
    expect(resolveIdp("alice@example.com", { "example.com": ["corp-entra"] })).toEqual({
      kind: "redirect",
      provider: "corp-entra",
    });
  });

  it("should return select with all candidates when multiple providers serve the domain", () => {
    expect(
      resolveIdp("alice@example.com", {
        "example.com": ["corp-entra", "corp-okta"],
      }),
    ).toEqual({
      kind: "select",
      providers: ["corp-entra", "corp-okta"],
    });
  });

  it("should treat email domain case-insensitively (= directory keys are lowercase)", () => {
    expect(resolveIdp("Alice@EXAMPLE.com", { "example.com": ["corp-entra"] })).toEqual({
      kind: "redirect",
      provider: "corp-entra",
    });
  });

  it("should resolve `local` when the resolved candidates after trimming are empty (= defensive)", () => {
    expect(
      resolveIdp("alice@example.com", { "example.com": ["", "  "] as unknown as string[] }),
    ).toEqual({
      kind: "local",
    });
  });

  it("should isolate tenants by reading only the directory it was given (= no cross-tenant leak)", () => {
    // 注入された directory に対する純粋な決定のみ。 tenant A の Login が tenant B の
    // directory を見ない isolation は infra layer (= per-tenant runtime-config.json) で
    // 担保されるが、 本関数も第二引数以外を読まない契約を pin する。
    const tenantA = { "example.com": ["corp-entra"] } as const;
    expect(resolveIdp("alice@example.com", tenantA)).toEqual({
      kind: "redirect",
      provider: "corp-entra",
    });
    // 別 directory を渡すと別の結論になる (= グローバル state 不在を pin)
    const tenantB = { "example.com": ["partner-okta"] } as const;
    expect(resolveIdp("alice@example.com", tenantB)).toEqual({
      kind: "redirect",
      provider: "partner-okta",
    });
  });
});
