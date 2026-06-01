import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../src/error-message";

/**
 * #1418 DRY: 3 SPA に byte-identical で重複していた toErrorMessage を web-kit へ集約した
 * 共有版の単体テスト。
 */
describe("toErrorMessage", () => {
  it("should return the message of an Error instance", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("should stringify non-Error values (string / object / number / null)", () => {
    expect(toErrorMessage("plain")).toBe("plain");
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage({ toString: () => "obj" })).toBe("obj");
  });

  it("should carry the message of an Error subclass", () => {
    class PortalError extends Error {}
    expect(toErrorMessage(new PortalError("nope"))).toBe("nope");
  });
});
