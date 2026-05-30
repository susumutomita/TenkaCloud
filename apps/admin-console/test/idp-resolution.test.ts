import { describe, expect, it } from "vitest";
import { distinctProviders, emailDomain, resolveIdp } from "../src/auth/idp-resolution";

/**
 * Issue #1335 Phase 1: Home Realm Discovery pure-function logic。 ProtoShip 移植時の挙動を
 * pinning し、 同一ドメイン複数 IdP の振り分けが drift しないようにする。
 */
describe("emailDomain (#1335)", () => {
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

describe("distinctProviders (#1335)", () => {
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

  it("should skip blank / whitespace-only provider names (= directory hygiene)", () => {
    expect(distinctProviders({ "a.com": ["", "  ", "corp-okta"] as unknown as string[] })).toEqual([
      "corp-okta",
    ]);
  });
});

describe("resolveIdp (#1335)", () => {
  it("should resolve `local` when the email has no domain at all (no @)", () => {
    expect(resolveIdp("no-at-sign", { "example.com": ["corp-entra"] })).toEqual({ kind: "local" });
  });

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
});
