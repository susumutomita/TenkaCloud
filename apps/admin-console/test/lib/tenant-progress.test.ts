import { describe, expect, it } from "vitest";
import { computeTenantProgress, isInProgress } from "../../src/lib/tenant-progress";

const BASE = Date.parse("2026-05-13T20:00:00.000Z");

describe("computeTenantProgress", () => {
  it('should return "3 分経過" + severity=ok 3 minutes after createdAt', () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:57:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("ok");
    expect(out.label).toBe("3 分経過");
  });

  it("should switch to severity=warning 32 minutes after createdAt", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:28:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
    expect(out.label).toBe("32 分経過");
  });

  it("should switch to severity=danger 75 minutes after createdAt (= suggests failure hang)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T18:45:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("danger");
    expect(out.label).toBe("1 時間 15 分経過");
  });

  it('should return label="—" + severity=ok when createdAt is absent', () => {
    const out = computeTenantProgress({ createdAt: undefined, nowMs: BASE });
    expect(out.severity).toBe("ok");
    expect(out.label).toBe("—");
  });

  it('should return label="—" when createdAt is an unparsable string as well (defensive)', () => {
    const out = computeTenantProgress({ createdAt: "not-an-iso-date", nowMs: BASE });
    expect(out.label).toBe("—");
  });

  it("should treat a future createdAt (= clock skew) as 0 seconds elapsed rather than negative", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T20:01:00.000Z",
      nowMs: BASE,
    });
    expect(out.elapsedMs).toBe(0);
    expect(out.label).toBe("0 秒経過");
  });

  it("should switch to severity=warning when elapsed time is exactly 30 minutes (= boundary value)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:30:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
  });

  it("should keep severity=ok at 30 minutes - 1 ms (= just before the boundary)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:30:00.001Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("ok");
  });

  it("should switch to severity=danger when elapsed time is exactly 60 minutes (= boundary value)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:00:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("danger");
  });

  it("should keep severity=warning at 60 minutes - 1 ms (= just before the boundary)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:00:00.001Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
  });
});

describe("isInProgress", () => {
  it('should treat the "In progress" value returned by SBT as true', () => {
    expect(isInProgress("In progress")).toBe(true);
  });

  it('should treat the "IN_PROGRESS" value returned by the ULID backend as true (defensive)', () => {
    expect(isInProgress("IN_PROGRESS")).toBe(true);
  });

  it('should also treat "Provisioning" as true (= SBT v0.3.10 line)', () => {
    expect(isInProgress("Provisioning")).toBe(true);
  });

  it("should return false for Complete / Failed / Deleted / undefined", () => {
    expect(isInProgress("Complete")).toBe(false);
    expect(isInProgress("Failed")).toBe(false);
    expect(isInProgress("Deleted")).toBe(false);
    expect(isInProgress(undefined)).toBe(false);
  });
});
