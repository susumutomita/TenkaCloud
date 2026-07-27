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

afterEach(() => {
  vi.restoreAllMocks();
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
    // Mock the property read performed by the production code. Node.js also exposes a global
    // Storage in recent releases, so spying on Storage.prototype can intercept the wrong
    // implementation and leave these catch branches untested.

    it("should fail open (treat the checkpoint as not-yet-shown) rather than throw", () => {
      vi.spyOn(window, "localStorage", "get").mockReturnValue({
        getItem: () => {
          throw new Error("SecurityError");
        },
      } as unknown as Storage);
      expect(hasLiteDrillCheckpointBeenShown("competitorVerified")).toBe(false);
    });

    it("should swallow a write failure rather than throw", () => {
      vi.spyOn(window, "localStorage", "get").mockReturnValue({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      } as unknown as Storage);
      expect(() => markLiteDrillCheckpointShown("competitorVerified")).not.toThrow();
    });
  });
});
