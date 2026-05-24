import { describe, expect, it } from "vitest";
import { resolveEventStatusTransition } from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";

/**
 * #557 / #539: pure-function transition resolver for the event reconciler.
 *
 * Covers `resolveEventStatusTransition` only — no DDB / mocks involved.
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

describe("resolveEventStatusTransition (#557 #539 pure logic)", () => {
  it("should transition to READY when DEPLOYING + all COMPLETE", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "COMPLETE"])).toBe("READY");
  });

  it("should transition to READY on DEPLOYING + mixed COMPLETE/FAILED (FAILED treated as terminal)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "FAILED", "COMPLETE"])).toBe(
      "READY",
    );
  });

  it("should return undefined when even one DEPLOYING + PENDING remains (don't move yet)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "PENDING"])).toBeUndefined();
  });

  it("should return undefined when DEPLOYING + IN_PROGRESS remain", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "IN_PROGRESS"])).toBeUndefined();
  });

  it("should transition to ARCHIVED on TEARDOWN + all DELETED", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETED"])).toBe("ARCHIVED");
  });

  it("should transition to ARCHIVED on TEARDOWN + mixed DELETED/FAILED (don't drag teardown failures)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "FAILED"])).toBe("ARCHIVED");
  });

  it("should return undefined when TEARDOWN + DELETING remain (still deleting)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETING"])).toBeUndefined();
  });

  it("should return undefined when child deployments are 0 (pre-bulk-deploy/delete race state, don't touch)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", [])).toBeUndefined();
    expect(resolveEventStatusTransition("TEARDOWN", [])).toBeUndefined();
  });

  it("should return undefined for out-of-scope status (DRAFT / ENDED / ARCHIVED) (defense in depth)", () => {
    expect(resolveEventStatusTransition("DRAFT", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("ENDED", ["DELETED"])).toBeUndefined();
    expect(resolveEventStatusTransition("ARCHIVED", ["DELETED"])).toBeUndefined();
  });

  // Issue #1038 P0 #3: READY + endsAt 経過の自動 ENDED 遷移
  it("should transition to ENDED when READY + endsAt is past now", () => {
    const endsAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse("2026-05-15T00:00:01.000Z");
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBe("ENDED");
  });

  it("should transition to ENDED when READY + endsAt equals now (boundary inclusive)", () => {
    const endsAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse(endsAt);
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBe("ENDED");
  });

  it("should return undefined when READY + endsAt is still in the future (don't touch)", () => {
    const endsAt = "2026-05-15T01:00:00.000Z";
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBeUndefined();
  });

  it("should return undefined when READY + endsAt is absent (don't touch open-ended events)", () => {
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(resolveEventStatusTransition("READY", [], { nowMs })).toBeUndefined();
  });

  it("should return undefined for READY + invalid endsAt (unparseable)", () => {
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(
      resolveEventStatusTransition("READY", [], { endsAt: "not-a-date", nowMs }),
    ).toBeUndefined();
  });

  it("should return undefined for READY without context (legacy caller compat)", () => {
    expect(resolveEventStatusTransition("READY", [])).toBeUndefined();
    expect(resolveEventStatusTransition("READY", ["COMPLETE"])).toBeUndefined();
  });
});
