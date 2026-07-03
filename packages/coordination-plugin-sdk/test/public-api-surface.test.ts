/**
 * [#2216] Frozen public API surface for the coordination plugin SDK.
 *
 * ADR-028 was adopted (#2195): the coordination contract now has a real reference
 * consumer (`packs/reference-coordination-battle`), so these exports are public
 * contract, not dead code. This test freezes the exact set of value exports —
 * `runTick` / `defineCoordinationPlugin` were the ones flagged as consumer-zero in
 * #2216, and the adopt decision is to KEEP them. Adding an export is a minor
 * version (update the list below in the same PR); removing or renaming one is a
 * major version. An accidental extra or missing export fails CI here.
 */

import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

/** The frozen set of runtime (value) exports. Types erase at runtime. */
const EXPECTED_VALUE_EXPORTS = [
  "defineCoordinationPlugin",
  "dispatchOp",
  "runTick",
  "safeProjectForTeam",
].sort();

describe("@tenkacloud/coordination-plugin-sdk public API surface", () => {
  it("should export exactly the frozen set of value names", () => {
    const actual = Object.keys(sdk).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it("should export the documented pure utilities as functions", () => {
    expect(typeof sdk.dispatchOp).toBe("function");
    expect(typeof sdk.runTick).toBe("function");
    expect(typeof sdk.defineCoordinationPlugin).toBe("function");
    expect(typeof sdk.safeProjectForTeam).toBe("function");
  });
});
