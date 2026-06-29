/**
 * [Problem SDK / Issue #2106] ReDoS regression tests for SemVer-range parsing.
 *
 * The `core` range in `tenkacloud-pack.json` is author-supplied and therefore
 * untrusted. Earlier the hyphen-range split used `split(/\s+-\s+/)` (adjacent
 * unbounded whitespace quantifiers), which is polynomial on a long all-whitespace
 * string. These tests pin the linear behavior: pathological input is rejected
 * quickly, valid ranges still match, and over-long input is rejected outright.
 */

import { describe, expect, it } from "vitest";
import { satisfiesCoreRange } from "../src/manifest.js";
import { validatePackManifest } from "../src/public-validators.js";
import { VALID_MANIFEST } from "./fixtures.js";

/** Build a manifest with a substituted `core` range. */
function manifestWithCore(core: string): Record<string, unknown> {
  return { ...VALID_MANIFEST, core };
}

describe("SemVer-range parsing is ReDoS-safe", () => {
  it("should reject a pathological all-whitespace core range quickly", () => {
    const pathological = " ".repeat(50_000);
    const start = performance.now();
    const diagnostics = validatePackManifest(manifestWithCore(pathological));
    const elapsedMs = performance.now() - start;

    expect(diagnostics.length).toBeGreaterThan(0);
    // Linear handling finishes in well under a second; a polynomial split would
    // blow far past this on 50k chars.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("should evaluate a many-space hyphen-like core range in linear time", () => {
    // Many-space separators that normalize to a single space. The result is not
    // the point — the point is that evaluation stays linear rather than blowing
    // up on the adjacent unbounded whitespace quantifiers it used to split on.
    const manySpaces = `1.0.0${" ".repeat(20_000)}-${" ".repeat(20_000)}2.0.0`;
    const start = performance.now();
    satisfiesCoreRange("1.2.3", manySpaces);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(500);

    // A truly malformed all-whitespace range returns false (and fast).
    expect(satisfiesCoreRange("1.2.3", " ".repeat(50_000))).toBe(false);
  });

  it("should reject a core range longer than the defense-in-depth length cap", () => {
    const tooLong = `>=1.0.0 ${"<2.0.0 ".repeat(1000)}`;
    expect(tooLong.length).toBeGreaterThan(256);
    expect(validatePackManifest(manifestWithCore(tooLong)).length).toBeGreaterThan(0);
  });

  it("should preserve valid range matching semantics after the linear rewrite", () => {
    expect(satisfiesCoreRange("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "^1.0.0")).toBe(false);
    // Hyphen range still works with normal single-space separators.
    expect(satisfiesCoreRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.1", "1.0.0 - 2.0.0")).toBe(false);
    // Irregular but finite whitespace normalizes to the same accept/reject result.
    expect(satisfiesCoreRange("1.5.0", "1.0.0   -   2.0.0")).toBe(true);
    expect(validatePackManifest(manifestWithCore("^1.0.0"))).toEqual([]);
  });
});
