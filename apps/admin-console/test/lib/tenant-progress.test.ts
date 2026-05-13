import { describe, expect, it } from "vitest";
import { computeTenantProgress, isInProgress } from "../../src/lib/tenant-progress";

const BASE = Date.parse("2026-05-13T20:00:00.000Z");

describe("computeTenantProgress", () => {
  it('createdAt の 3 分後は "3 分経過" + severity=ok を返すべき', () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:57:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("ok");
    expect(out.label).toBe("3 分経過");
  });

  it("createdAt の 32 分後は severity=warning に切り替わるべき", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:28:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
    expect(out.label).toBe("32 分経過");
  });

  it("createdAt の 75 分後は severity=danger に切り替わるべき (= 失敗ハング示唆)", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T18:45:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("danger");
    expect(out.label).toBe("1 時間 15 分経過");
  });

  it('createdAt 不在の場合は label="—" + severity=ok を返すべき', () => {
    const out = computeTenantProgress({ createdAt: undefined, nowMs: BASE });
    expect(out.severity).toBe("ok");
    expect(out.label).toBe("—");
  });

  it('createdAt が parse 不能な string の場合も label="—" を返すべき (defensive)', () => {
    const out = computeTenantProgress({ createdAt: "not-an-iso-date", nowMs: BASE });
    expect(out.label).toBe("—");
  });

  it("createdAt が未来 (= clock skew) でも負数経過ではなく 0 秒経過扱い", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T20:01:00.000Z",
      nowMs: BASE,
    });
    expect(out.elapsedMs).toBe(0);
    expect(out.label).toBe("0 秒経過");
  });

  it("経過時間が正確に 30 分 (= 境界値) の場合は severity=warning に切り替わるべき", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:30:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
  });

  it("経過時間が 30 分 - 1 ms (= 境界値直前) は severity=ok を維持するべき", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:30:00.001Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("ok");
  });

  it("経過時間が正確に 60 分 (= 境界値) の場合は severity=danger に切り替わるべき", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:00:00.000Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("danger");
  });

  it("経過時間が 60 分 - 1 ms (= 境界値直前) は severity=warning を維持するべき", () => {
    const out = computeTenantProgress({
      createdAt: "2026-05-13T19:00:00.001Z",
      nowMs: BASE,
    });
    expect(out.severity).toBe("warning");
  });
});

describe("isInProgress", () => {
  it('SBT が返す "In progress" を真と判定するべき', () => {
    expect(isInProgress("In progress")).toBe(true);
  });

  it('ULID backend が返す "IN_PROGRESS" を真と判定するべき (defensive)', () => {
    expect(isInProgress("IN_PROGRESS")).toBe(true);
  });

  it('"Provisioning" も真と判定するべき (= SBT v0.3.10 系)', () => {
    expect(isInProgress("Provisioning")).toBe(true);
  });

  it("Complete / Failed / Deleted / undefined は偽を返すべき", () => {
    expect(isInProgress("Complete")).toBe(false);
    expect(isInProgress("Failed")).toBe(false);
    expect(isInProgress("Deleted")).toBe(false);
    expect(isInProgress(undefined)).toBe(false);
  });
});
