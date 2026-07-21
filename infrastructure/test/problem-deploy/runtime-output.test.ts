import { describe, expect, it } from "vitest";
import { stringifyRuntimeOutput } from "../../lib/problem-deploy/runtime-clients/runtime-output.js";

describe("stringifyRuntimeOutput", () => {
  it("should preserve strings and stringify primitive values", () => {
    expect(stringifyRuntimeOutput("value", "provider")).toBe("value");
    expect(stringifyRuntimeOutput(2, "provider")).toBe("2");
    expect(stringifyRuntimeOutput(true, "provider")).toBe("true");
    expect(stringifyRuntimeOutput(null, "provider")).toBe("");
    expect(stringifyRuntimeOutput(undefined, "provider")).toBe("");
  });

  it("should serialize structured values deterministically", () => {
    expect(stringifyRuntimeOutput({ nested: ["value"] }, "provider")).toBe('{"nested":["value"]}');
  });

  it("should fail loudly for unsupported or circular values", () => {
    expect(() => stringifyRuntimeOutput(() => undefined, "provider-x")).toThrow(
      "provider-x returned an output that is not JSON serializable",
    );

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => stringifyRuntimeOutput(circular, "provider-y")).toThrow(
      "provider-y returned an output that is not JSON serializable",
    );
  });
});
