import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../../src/lib/error-message";

describe("toErrorMessage", () => {
  it("should return the message of an Error", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("should return the message of an Error subclass", () => {
    class CustomError extends Error {}
    expect(toErrorMessage(new CustomError("custom boom"))).toBe("custom boom");
  });

  it("should stringify a non-Error value", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage(undefined)).toBe("undefined");
    expect(toErrorMessage({ code: "X" })).toBe("[object Object]");
  });
});
