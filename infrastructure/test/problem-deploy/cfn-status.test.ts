import { describe, expect, it } from "vitest";
import { parseStackOutputs } from "../../lib/problem-deploy/handlers/shared/cfn-status";

describe("parseStackOutputs", () => {
  it("should return an empty object for undefined / empty string / broken JSON", () => {
    expect(parseStackOutputs(undefined)).toEqual({});
    expect(parseStackOutputs("")).toEqual({});
    expect(parseStackOutputs("{not-json")).toEqual({});
  });

  it("should convert `{key: value}` form (from Lambda) back to Record<string,string>", () => {
    expect(
      parseStackOutputs(JSON.stringify({ FrontendUrl: "http://x", ApiUrl: "http://y" })),
    ).toEqual({
      FrontendUrl: "http://x",
      ApiUrl: "http://y",
    });
  });

  it("should also parse `[{OutputKey, OutputValue}, ...]` form (from Step Functions describeStacks)", () => {
    const cfnNative = JSON.stringify([
      { OutputKey: "ParameterValue", OutputValue: "Hello from tc-...", Description: "x" },
      { OutputKey: "ParameterName", OutputValue: "/tc-.../hello" },
    ]);
    expect(parseStackOutputs(cfnNative)).toEqual({
      ParameterValue: "Hello from tc-...",
      ParameterName: "/tc-.../hello",
    });
  });

  it("should skip entries with non-string values (best-effort)", () => {
    expect(parseStackOutputs(JSON.stringify({ A: "ok", B: 123, C: null }))).toEqual({ A: "ok" });
    expect(
      parseStackOutputs(
        JSON.stringify([
          { OutputKey: "A", OutputValue: "ok" },
          { OutputKey: "B", OutputValue: 123 },
          { OutputKey: 999, OutputValue: "skipped" },
        ]),
      ),
    ).toEqual({ A: "ok" });
  });
});
