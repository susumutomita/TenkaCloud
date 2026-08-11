import { describe, expect, it } from "vitest";
import { type FeatureRegistry, resolveFeatureFlags } from "../src/feature-flags";

/**
 * Shared feature-flag resolver. Pins: registry default when unset, boolean override wins,
 * non-boolean / unknown override ignored, and the result surface is exactly the registry keys.
 */
const REGISTRY = {
  samlSso: { description: "SAML SSO", stability: "experimental", defaultEnabled: false },
  nonAwsRuntime: {
    description: "Non-AWS runtimes",
    stability: "experimental",
    defaultEnabled: false,
  },
  scoreboard: { description: "Scoreboard", stability: "stable", defaultEnabled: true },
} as const satisfies FeatureRegistry;

describe("resolveFeatureFlags", () => {
  it("should use each registry default when no overrides are given", () => {
    expect(resolveFeatureFlags(REGISTRY)).toEqual({
      samlSso: false,
      nonAwsRuntime: false,
      scoreboard: true,
    });
  });

  it("should let a boolean override win over the default (both directions)", () => {
    expect(resolveFeatureFlags(REGISTRY, { samlSso: true, scoreboard: false })).toEqual({
      samlSso: true,
      nonAwsRuntime: false,
      scoreboard: false,
    });
  });

  it("should ignore a non-boolean override and fall back to the default", () => {
    // a hand-edited config might put "true" (string) / 1 / null — none flip the flag.
    expect(
      resolveFeatureFlags(REGISTRY, {
        samlSso: "true" as unknown as boolean,
        nonAwsRuntime: 1 as unknown as boolean,
        scoreboard: null as unknown as boolean,
      }),
    ).toEqual({ samlSso: false, nonAwsRuntime: false, scoreboard: true });
  });

  it("should ignore unknown override keys and only emit registry keys", () => {
    const out = resolveFeatureFlags(REGISTRY, { somethingElse: true, samlSso: true });
    expect(out).toEqual({ samlSso: true, nonAwsRuntime: false, scoreboard: true });
    expect(Object.keys(out).sort()).toEqual(["nonAwsRuntime", "samlSso", "scoreboard"]);
  });

  it("should treat null/undefined overrides as no overrides", () => {
    expect(resolveFeatureFlags(REGISTRY, null)).toEqual(resolveFeatureFlags(REGISTRY));
    expect(resolveFeatureFlags(REGISTRY, undefined)).toEqual(resolveFeatureFlags(REGISTRY));
  });

  it("should return an empty object for an empty registry", () => {
    expect(resolveFeatureFlags({}, { anything: true })).toEqual({});
  });
});
