import { describe, expect, it } from "vitest";
import { seededValue } from "../src/run-values.js";

describe("seededValue", () => {
  it("should be deterministic for the same seed + label", () => {
    expect(seededValue("seed-a", "victimId")).toBe(seededValue("seed-a", "victimId"));
  });

  it("should differ across seeds (run-to-run variation)", () => {
    expect(seededValue("seed-a", "victimId")).not.toBe(seededValue("seed-b", "victimId"));
  });

  it("should differ across labels within a run", () => {
    expect(seededValue("seed-a", "victimId")).not.toBe(seededValue("seed-a", "attackerId"));
  });

  it("should honor the requested length and clamp to at least 1 char", () => {
    expect(seededValue("seed-a", "x", 6)).toHaveLength(6);
    expect(seededValue("seed-a", "x", 0)).toHaveLength(1);
  });
});
