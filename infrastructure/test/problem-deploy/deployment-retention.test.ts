import { describe, expect, it } from "vitest";
import { deploymentTerminalExpiresAt } from "../../lib/problem-deploy/handlers/shared/deployment-retention.js";

/**
 * Issue #1200: Deployments 行が terminal 化したタイミングで `expiresAt` を 7 日先に
 * refresh する helper のテスト。 caller (= deploy-handler/{deploy,retry,delete}.ts) が
 * UpdateItemCommand の `:expiresAt` slot に本値を渡す前提。
 */

describe("deploymentTerminalExpiresAt", () => {
  it("should return epoch-seconds 7 days ahead of given nowMs", () => {
    const nowMs = Date.parse("2026-05-22T19:00:00Z");
    const expected = Math.floor((nowMs + 7 * 24 * 60 * 60 * 1000) / 1000);
    expect(deploymentTerminalExpiresAt(nowMs)).toBe(expected);
  });

  it("should produce an epoch-seconds value (= not milliseconds)", () => {
    const nowMs = Date.parse("2026-05-22T19:00:00Z");
    const result = deploymentTerminalExpiresAt(nowMs);
    // epoch seconds for 2026-05-22 is around 1.7e9, milliseconds would be 1.7e12.
    expect(result).toBeLessThan(2_000_000_000);
    expect(result).toBeGreaterThan(1_500_000_000);
  });

  it("should be monotonic in nowMs (= later now → later expiry)", () => {
    const t1 = Date.parse("2026-05-22T19:00:00Z");
    const t2 = t1 + 60 * 1000;
    expect(deploymentTerminalExpiresAt(t2)).toBeGreaterThan(deploymentTerminalExpiresAt(t1));
  });
});
