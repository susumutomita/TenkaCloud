import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../../src/lib/error-message";

/**
 * Issue #1418: TenantDetail / Jobs にコピペされていた `err instanceof Error ? err.message :
 * String(err)` を toErrorMessage に集約した。 その純関数の 2 分岐を直接 pin する。
 */
describe("toErrorMessage", () => {
  it("should return an Error's message", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("should stringify a non-Error value", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
    expect(toErrorMessage(42)).toBe("42");
  });
});
