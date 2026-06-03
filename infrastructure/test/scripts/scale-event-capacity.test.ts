import { describe, expect, it, vi } from "vitest";
import {
  applyCapacityPlan,
  DEFAULT_MAX_UNITS_PER_TABLE,
  planCapacityChange,
} from "../../../scripts/lib/scale-event-capacity";

/**
 * [Issue #1667] runtime-adjustable DDB capacity の planner + guardrail + apply を pin。
 * 暴走 (非正整数 / per-table 上限超過 / table 未指定) は reject、 Free Tier 超過 / GSI は warning、
 * apply は 1 件失敗しても残りを試みて applied/failed を返す。
 */

const plan = (over: Partial<Parameters<typeof planCapacityChange>[0]> = {}) =>
  planCapacityChange({
    tables: ["Deployments"],
    target: { readCapacity: 1, writeCapacity: 1 },
    maxUnitsPerTable: DEFAULT_MAX_UNITS_PER_TABLE,
    ...over,
  });

describe("planCapacityChange (#1667)", () => {
  it("should plan a baseline (1/1) change for teardown with no warnings", () => {
    const r = plan({ tables: ["Deployments", "Events"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toEqual([
        { table: "Deployments", readCapacity: 1, writeCapacity: 1 },
        { table: "Events", readCapacity: 1, writeCapacity: 1 },
      ]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("should warn when raising above the baseline and beyond the Free Tier total", () => {
    const r = plan({
      tables: ["a", "b", "c"],
      target: { readCapacity: 10, writeCapacity: 10 }, // 30 RCU/WCU total > 25
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes("Free Tier") && w.includes("WILL incur cost"))).toBe(
        true,
      );
      expect(r.warnings.some((w) => w.includes("GSI throughput is NOT changed"))).toBe(true);
    }
  });

  it("should reject a non-positive or non-integer capacity", () => {
    expect(plan({ target: { readCapacity: 0, writeCapacity: 1 } }).ok).toBe(false);
    expect(plan({ target: { readCapacity: 1, writeCapacity: 2.5 } }).ok).toBe(false);
  });

  it("should reject a capacity above the per-table cap (cost guardrail)", () => {
    const r = plan({ target: { readCapacity: 50, writeCapacity: 1 }, maxUnitsPerTable: 25 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("exceeds the per-table cap"))).toBe(true);
  });

  it("should reject when no tables are given", () => {
    const r = plan({ tables: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("no tables specified");
  });
});

describe("applyCapacityPlan (#1667)", () => {
  it("should apply every entry via the injected updateTable", async () => {
    const updateTable = vi.fn().mockResolvedValue(undefined);
    const res = await applyCapacityPlan(
      [
        { table: "Deployments", readCapacity: 5, writeCapacity: 5 },
        { table: "Events", readCapacity: 5, writeCapacity: 5 },
      ],
      { updateTable },
    );
    expect(res.applied).toEqual(["Deployments", "Events"]);
    expect(res.failed).toEqual([]);
    expect(updateTable).toHaveBeenCalledWith("Deployments", 5, 5);
  });

  it("should record a failure but still apply the rest", async () => {
    const updateTable = vi
      .fn()
      .mockRejectedValueOnce(new Error("ResourceNotFoundException"))
      .mockResolvedValue(undefined);
    const res = await applyCapacityPlan(
      [
        { table: "Missing", readCapacity: 5, writeCapacity: 5 },
        { table: "Events", readCapacity: 5, writeCapacity: 5 },
      ],
      { updateTable },
    );
    expect(res.applied).toEqual(["Events"]);
    expect(res.failed).toEqual([{ table: "Missing", error: "ResourceNotFoundException" }]);
  });
});
