/**
 * [Problem SDK / Issue #2106] Frozen public API surface.
 *
 * The exact set of exported names is the contract. Adding an export is a minor
 * version (update the list below in the same PR); removing or renaming one is a
 * major version. An accidental extra or missing export fails CI here.
 */

import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

/** The frozen set of runtime (value) exports. Types erase at runtime. */
const EXPECTED_VALUE_EXPORTS = [
  "PACK_SCHEMA_VERSION",
  "SUPPORTED_RUNTIME_CAPABILITIES",
  "buildPackReport",
  "computeContentDigest",
  "formatDiagnostics",
  "serializePackReport",
  "validatePackDirectory",
  "validatePackManifest",
  "validateProblemMetadata",
].sort();

describe("@tenkacloud/problem-sdk public API surface", () => {
  it("should export exactly the frozen set of value names", () => {
    const actual = Object.keys(sdk).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it("should export the documented value kinds", () => {
    expect(typeof sdk.PACK_SCHEMA_VERSION).toBe("number");
    expect(Array.isArray(sdk.SUPPORTED_RUNTIME_CAPABILITIES)).toBe(true);
    expect(typeof sdk.buildPackReport).toBe("function");
    expect(typeof sdk.computeContentDigest).toBe("function");
    expect(typeof sdk.serializePackReport).toBe("function");
    expect(typeof sdk.formatDiagnostics).toBe("function");
    expect(typeof sdk.validatePackDirectory).toBe("function");
    expect(typeof sdk.validatePackManifest).toBe("function");
    expect(typeof sdk.validateProblemMetadata).toBe("function");
  });
});
