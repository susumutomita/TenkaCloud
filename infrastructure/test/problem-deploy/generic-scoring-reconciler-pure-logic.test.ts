import { describe, expect, it } from "vitest";
import {
  resolveEventStatusTransition,
  resolveScheduledDeployDue,
  resolveScheduledTeardownDue,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";

/**
 * #557 / #539: pure-function transition resolver for the event reconciler.
 *
 * Covers `resolveEventStatusTransition` only — no DDB / mocks involved.
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

const TEARDOWN_NOW_MS = Date.parse("2026-05-08T12:00:00.000Z");
const TEARDOWN_PAST = "2026-05-08T11:00:00.000Z"; // now より前
const TEARDOWN_FUTURE = "2026-05-08T13:00:00.000Z"; // now より後

describe("resolveScheduledTeardownDue (pure logic)", () => {
  it("should be due when READY + teardownAt has passed", () => {
    expect(
      resolveScheduledTeardownDue({ status: "READY", teardownAt: TEARDOWN_PAST }, TEARDOWN_NOW_MS),
    ).toBe(true);
  });

  it("should be due when ENDED + teardownAt has passed", () => {
    expect(
      resolveScheduledTeardownDue({ status: "ENDED", teardownAt: TEARDOWN_PAST }, TEARDOWN_NOW_MS),
    ).toBe(true);
  });

  it("should NOT be due while DEPLOYING (avoid mid-deploy teardown)", () => {
    expect(
      resolveScheduledTeardownDue(
        { status: "DEPLOYING", teardownAt: TEARDOWN_PAST },
        TEARDOWN_NOW_MS,
      ),
    ).toBe(false);
  });

  it("should NOT be due for DRAFT / TEARDOWN / ARCHIVED", () => {
    for (const status of ["DRAFT", "TEARDOWN", "ARCHIVED"]) {
      expect(
        resolveScheduledTeardownDue({ status, teardownAt: TEARDOWN_PAST }, TEARDOWN_NOW_MS),
      ).toBe(false);
    }
  });

  it("should NOT be due when teardownAt is still in the future", () => {
    expect(
      resolveScheduledTeardownDue(
        { status: "READY", teardownAt: TEARDOWN_FUTURE },
        TEARDOWN_NOW_MS,
      ),
    ).toBe(false);
  });

  it("should NOT be due when teardownAt is unset", () => {
    expect(resolveScheduledTeardownDue({ status: "READY" }, TEARDOWN_NOW_MS)).toBe(false);
  });

  it("should NOT re-fire once teardownFiredAt is recorded", () => {
    expect(
      resolveScheduledTeardownDue(
        { status: "READY", teardownAt: TEARDOWN_PAST, teardownFiredAt: TEARDOWN_PAST },
        TEARDOWN_NOW_MS,
      ),
    ).toBe(false);
  });

  it("should NOT be due when teardownAt is unparseable", () => {
    expect(
      resolveScheduledTeardownDue({ status: "READY", teardownAt: "not-a-date" }, TEARDOWN_NOW_MS),
    ).toBe(false);
  });
});

describe("resolveScheduledDeployDue (pure logic)", () => {
  // teardown と同じ now/past/future fixtures を再利用 (= deployAt 経過 / 未到来 / 不在 を表す)。
  it("should be due when DRAFT + deployAt has passed", () => {
    expect(
      resolveScheduledDeployDue({ status: "DRAFT", deployAt: TEARDOWN_PAST }, TEARDOWN_NOW_MS),
    ).toBe(true);
  });

  it("should be due when DRAFT + deployAt equals now (boundary inclusive)", () => {
    const at = "2026-05-08T12:00:00.000Z";
    expect(resolveScheduledDeployDue({ status: "DRAFT", deployAt: at }, Date.parse(at))).toBe(true);
  });

  it("should NOT be due once already deployed (DEPLOYING / READY / ENDED / TEARDOWN / ARCHIVED)", () => {
    for (const status of ["DEPLOYING", "READY", "ENDED", "TEARDOWN", "ARCHIVED"]) {
      expect(resolveScheduledDeployDue({ status, deployAt: TEARDOWN_PAST }, TEARDOWN_NOW_MS)).toBe(
        false,
      );
    }
  });

  it("should NOT be due when deployAt is still in the future", () => {
    expect(
      resolveScheduledDeployDue({ status: "DRAFT", deployAt: TEARDOWN_FUTURE }, TEARDOWN_NOW_MS),
    ).toBe(false);
  });

  it("should NOT be due when deployAt is unset", () => {
    expect(resolveScheduledDeployDue({ status: "DRAFT" }, TEARDOWN_NOW_MS)).toBe(false);
  });

  it("should NOT re-fire once deployFiredAt is recorded", () => {
    expect(
      resolveScheduledDeployDue(
        { status: "DRAFT", deployAt: TEARDOWN_PAST, deployFiredAt: TEARDOWN_PAST },
        TEARDOWN_NOW_MS,
      ),
    ).toBe(false);
  });

  it("should NOT be due when deployAt is unparseable", () => {
    expect(
      resolveScheduledDeployDue({ status: "DRAFT", deployAt: "not-a-date" }, TEARDOWN_NOW_MS),
    ).toBe(false);
  });

  it("should NOT be due when nowMs is not finite (defense in depth)", () => {
    expect(
      resolveScheduledDeployDue({ status: "DRAFT", deployAt: TEARDOWN_PAST }, Number.NaN),
    ).toBe(false);
  });
});

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
