/**
 * [Composite Runtime / Issue #2067] Exhaustive truth-table tests for the pure
 * deploy-phase composite parent status aggregator.
 */

import { describe, expect, it } from "vitest";
import {
  aggregateCompositeDeployStatus,
  CompositeStatusError,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-status";
import type { DeploymentStatus } from "../../lib/problem-deploy/handlers/deploy-handler/types";

describe("aggregateCompositeDeployStatus (#2067)", () => {
  it("returns PENDING when all targets are PENDING", () => {
    expect(aggregateCompositeDeployStatus(["PENDING", "PENDING", "PENDING"])).toBe("PENDING");
  });

  it("returns IN_PROGRESS for mixed pending in-progress and complete targets", () => {
    expect(aggregateCompositeDeployStatus(["PENDING", "IN_PROGRESS", "COMPLETE"])).toBe(
      "IN_PROGRESS",
    );
  });

  it("returns COMPLETE only when all targets are COMPLETE", () => {
    expect(aggregateCompositeDeployStatus(["COMPLETE", "COMPLETE"])).toBe("COMPLETE");
    expect(aggregateCompositeDeployStatus(["COMPLETE", "PENDING"])).toBe("IN_PROGRESS");
  });

  it("returns FAILED when any target failed", () => {
    expect(aggregateCompositeDeployStatus(["PENDING", "FAILED"])).toBe("FAILED");
  });

  it("returns FAILED even when another target is COMPLETE", () => {
    expect(aggregateCompositeDeployStatus(["COMPLETE", "FAILED"])).toBe("FAILED");
    expect(aggregateCompositeDeployStatus(["COMPLETE", "COMPLETE", "FAILED"])).toBe("FAILED");
  });

  it("treats APPROVAL_PENDING as in-progress", () => {
    expect(aggregateCompositeDeployStatus(["APPROVAL_PENDING"])).toBe("IN_PROGRESS");
    expect(aggregateCompositeDeployStatus(["PENDING", "APPROVAL_PENDING"])).toBe("IN_PROGRESS");
    // APPROVAL_PENDING does not override FAILED.
    expect(aggregateCompositeDeployStatus(["APPROVAL_PENDING", "FAILED"])).toBe("FAILED");
  });

  it("throws for empty targets", () => {
    expect(() => aggregateCompositeDeployStatus([])).toThrow(CompositeStatusError);
  });

  it("throws for deleting deleted expired and auto-deleted targets", () => {
    const deletionLike: DeploymentStatus[] = ["DELETING", "DELETED", "EXPIRED", "AUTO_DELETED"];
    for (const status of deletionLike) {
      expect(() => aggregateCompositeDeployStatus([status])).toThrow(CompositeStatusError);
      // Rejected even mixed with otherwise-valid deploy states (no guessing).
      expect(() => aggregateCompositeDeployStatus(["COMPLETE", status])).toThrow(
        CompositeStatusError,
      );
    }
  });

  it("is invariant to target order", () => {
    expect(aggregateCompositeDeployStatus(["FAILED", "COMPLETE", "PENDING"])).toBe(
      aggregateCompositeDeployStatus(["PENDING", "COMPLETE", "FAILED"]),
    );
    expect(aggregateCompositeDeployStatus(["COMPLETE", "IN_PROGRESS"])).toBe(
      aggregateCompositeDeployStatus(["IN_PROGRESS", "COMPLETE"]),
    );
    expect(aggregateCompositeDeployStatus(["PENDING", "PENDING"])).toBe(
      aggregateCompositeDeployStatus(["PENDING", "PENDING"]),
    );
  });

  it("returns PENDING / COMPLETE only for the homogeneous single-target case", () => {
    expect(aggregateCompositeDeployStatus(["PENDING"])).toBe("PENDING");
    expect(aggregateCompositeDeployStatus(["COMPLETE"])).toBe("COMPLETE");
    expect(aggregateCompositeDeployStatus(["IN_PROGRESS"])).toBe("IN_PROGRESS");
    expect(aggregateCompositeDeployStatus(["FAILED"])).toBe("FAILED");
  });
});
