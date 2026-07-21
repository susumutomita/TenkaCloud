import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasLiteDrillCheckpointBeenShown,
  liteDrillCheckpointCode,
  markLiteDrillCheckpointShown,
} from "./lite-drill";

beforeEach(() => {
  window.localStorage.clear();
});

describe("liteDrillCheckpointCode (#2696)", () => {
  it("should return the checkpoint code when the console runs in Lite mode (tenantId=local)", () => {
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "competitorVerified")).toBe(
      LITE_DRILL_CHECKPOINTS.competitorVerified.code,
    );
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "firstEventCreated")).toBe(
      LITE_DRILL_CHECKPOINTS.firstEventCreated.code,
    );
  });

  it("should hide the code for SaaS tenants and the no-AWS demo mode", () => {
    expect(liteDrillCheckpointCode({ tenantId: "pooled" }, "competitorVerified")).toBeUndefined();
    expect(
      liteDrillCheckpointCode({ tenantId: "demo-tenant" }, "firstEventCreated"),
    ).toBeUndefined();
  });

  it("should stop returning the code once it has been marked shown (2026-07-21)", () => {
    expect(hasLiteDrillCheckpointBeenShown("competitorVerified")).toBe(false);
    markLiteDrillCheckpointShown("competitorVerified");
    expect(hasLiteDrillCheckpointBeenShown("competitorVerified")).toBe(true);
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "competitorVerified")).toBeUndefined();
    // the other checkpoint is unaffected
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "firstEventCreated")).toBe(
      LITE_DRILL_CHECKPOINTS.firstEventCreated.code,
    );
  });

  describe("when localStorage throws (private mode / disabled storage)", () => {
    // Spies must be (re)created per-test: a spy created once at describe-body-eval time is
    // torn down by the first test's afterEach, so a second test's mockImplementation would
    // mutate an already-restored (detached) spy and silently exercise the real, non-throwing
    // localStorage instead — the assertion would then pass even with no try/catch in the
    // source (2026-07-21 review finding: this made the write-failure test vacuous).
    let getItem: ReturnType<typeof vi.spyOn>;
    let setItem: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      getItem = vi.spyOn(Storage.prototype, "getItem");
      setItem = vi.spyOn(Storage.prototype, "setItem");
    });

    afterEach(() => {
      getItem.mockRestore();
      setItem.mockRestore();
    });

    it("should fail open (treat the checkpoint as not-yet-shown) rather than throw", () => {
      getItem.mockImplementation(() => {
        throw new Error("SecurityError");
      });
      expect(hasLiteDrillCheckpointBeenShown("competitorVerified")).toBe(false);
    });

    it("should swallow a write failure rather than throw", () => {
      setItem.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      expect(() => markLiteDrillCheckpointShown("competitorVerified")).not.toThrow();
    });
  });
});
