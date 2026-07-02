/**
 * [Problem SDK / Issue #2106] Direct tests for the dependency-free SemVer-range
 * matcher and the manifest range/version validators — covering each comparator
 * operator and the wildcard / hyphen / OR clause grammar.
 */

import { describe, expect, it } from "vitest";
import { validatePackManifest } from "../src/public-validators.js";
import { satisfiesCoreRange } from "../src/semver-range.js";
import { VALID_MANIFEST } from "./fixtures.js";

describe("satisfiesCoreRange: comparator operators", () => {
  it("should handle caret ranges across 0.x and 1.x", () => {
    expect(satisfiesCoreRange("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesCoreRange("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfiesCoreRange("0.3.0", "^0.2.0")).toBe(false);
  });

  it("should handle tilde ranges", () => {
    expect(satisfiesCoreRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesCoreRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesCoreRange("1.9.0", "~1")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "~1")).toBe(false);
  });

  it("should handle >=, >, <=, <, and = operators", () => {
    expect(satisfiesCoreRange("1.5.0", ">=1.0.0")).toBe(true);
    expect(satisfiesCoreRange("0.9.0", ">=1.0.0")).toBe(false);
    expect(satisfiesCoreRange("2.0.0", ">1.0.0")).toBe(true);
    expect(satisfiesCoreRange("0.9.0", "<1.0.0")).toBe(true);
    expect(satisfiesCoreRange("1.0.0", "<1.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", "<=1.0.0")).toBe(true);
    expect(satisfiesCoreRange("1.0.0", "=1.0.0")).toBe(true);
    expect(satisfiesCoreRange("1.0.1", "=1.0.0")).toBe(false);
  });

  it("should handle wildcards, hyphen ranges, AND clauses, and OR clauses", () => {
    expect(satisfiesCoreRange("3.1.4", "*")).toBe(true);
    expect(satisfiesCoreRange("1.5.0", "1.x")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "1.x")).toBe(false);
    expect(satisfiesCoreRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.5.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.5.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesCoreRange("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
  });

  it("should return false for an invalid version or range", () => {
    expect(satisfiesCoreRange("not-semver", "^1.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", "")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", "@@@")).toBe(false);
  });
});

describe("manifest version / range validation", () => {
  it("should reject a malformed version and a malformed core range", () => {
    expect(validatePackManifest({ ...VALID_MANIFEST, version: "1.0" }).length).toBeGreaterThan(0);
    expect(validatePackManifest({ ...VALID_MANIFEST, core: "@@@" }).length).toBeGreaterThan(0);
  });

  it("should accept a valid pre-release version and an OR core range", () => {
    expect(validatePackManifest({ ...VALID_MANIFEST, version: "1.0.0-rc.1" })).toEqual([]);
    expect(validatePackManifest({ ...VALID_MANIFEST, core: ">=1.0.0 <2.0.0 || ^3.0.0" })).toEqual(
      [],
    );
  });
});

describe("satisfiesCoreRange: pre-release precedence (semver.org §11)", () => {
  it("should rank a pre-release lower than its release", () => {
    // 1.0.0-rc.1 < 1.0.0, so it does NOT satisfy >=1.0.0.
    expect(satisfiesCoreRange("1.0.0-rc.1", ">=1.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", ">=1.0.0")).toBe(true);
    // ...but it does satisfy >=1.0.0-rc.1.
    expect(satisfiesCoreRange("1.0.0-rc.1", ">=1.0.0-rc.1")).toBe(true);
  });

  it("should order pre-release identifiers field by field", () => {
    // numeric < numeric, numeric < alphanumeric, longer set outranks a prefix.
    expect(satisfiesCoreRange("1.0.0-alpha.1", ">1.0.0-alpha")).toBe(true);
    expect(satisfiesCoreRange("1.0.0-alpha", ">1.0.0-alpha.1")).toBe(false);
    expect(satisfiesCoreRange("1.0.0-beta", ">1.0.0-alpha")).toBe(true);
    expect(satisfiesCoreRange("1.0.0-1", "<1.0.0-alpha")).toBe(true);
  });

  it("should ignore build metadata in precedence", () => {
    expect(satisfiesCoreRange("1.0.0+build.7", "=1.0.0")).toBe(true);
  });
});

describe("satisfiesCoreRange / isValidSemverRange: hyphen-range bounds", () => {
  it("should reject a comparator-prefixed hyphen-range bound at validation time", () => {
    // `>=1.2.3 - <2.0.0` would make tokenBounds produce NaN — reject it outright.
    expect(
      validatePackManifest({ ...VALID_MANIFEST, core: ">=1.2.3 - <2.0.0" }).length,
    ).toBeGreaterThan(0);
    expect(satisfiesCoreRange("1.5.0", ">=1.2.3 - <2.0.0")).toBe(false);
  });

  it("should still accept a plain-version hyphen range", () => {
    expect(validatePackManifest({ ...VALID_MANIFEST, core: "1.0.0 - 2.0.0" })).toEqual([]);
    expect(satisfiesCoreRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
  });
});
