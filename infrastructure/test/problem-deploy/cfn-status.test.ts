import { describe, expect, it } from "vitest";
import {
  parseStackOutputs,
  resolveDeploymentStatus,
  serializeStackOutputs,
} from "../../lib/problem-deploy/handlers/shared/cfn-status";

describe("resolveDeploymentStatus", () => {
  it("should return the CREATE_COMPLETE → COMPLETE transition", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "CREATE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "COMPLETE",
    });
  });

  it("should also treat UPDATE_COMPLETE as COMPLETE", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "UPDATE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "COMPLETE",
    });
  });

  it("should embed CREATE_FAILED → FAILED + reason", () => {
    const r = resolveDeploymentStatus("IN_PROGRESS", "CREATE_FAILED", "VPC limit exceeded");
    expect(r).toEqual({
      kind: "transition",
      status: "FAILED",
      failureReason: "CREATE_FAILED: VPC limit exceeded",
    });
  });

  it("should fall ROLLBACK_COMPLETE to FAILED", () => {
    const r = resolveDeploymentStatus("IN_PROGRESS", "ROLLBACK_COMPLETE", undefined);
    expect(r).toEqual({ kind: "transition", status: "FAILED", failureReason: "ROLLBACK_COMPLETE" });
  });

  it("should return the DELETE_COMPLETE → DELETED transition", () => {
    expect(resolveDeploymentStatus("DELETING", "DELETE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "DELETED",
    });
  });

  it("should not re-transition on CREATE_COMPLETE when already COMPLETE (double-fire guard)", () => {
    expect(resolveDeploymentStatus("COMPLETE", "CREATE_COMPLETE", undefined)).toEqual({
      kind: "stable",
    });
  });

  it("CREATE_IN_PROGRESS は stable (内部 IN_PROGRESS を維持)", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "CREATE_IN_PROGRESS", undefined)).toEqual({
      kind: "stable",
    });
  });

  it("should fall unknown StackStatus to stable on the safe side", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "FUTURE_NEW_STATUS", undefined)).toEqual({
      kind: "stable",
    });
  });

  it("cfnStatus 不明 (undefined) なら stable", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", undefined, undefined)).toEqual({
      kind: "stable",
    });
  });
});

describe("serializeStackOutputs", () => {
  it("should turn Outputs into OutputKey -> OutputValue JSON", () => {
    const json = serializeStackOutputs([
      { OutputKey: "FrontendUrl", OutputValue: "http://example.com" },
      { OutputKey: "ApiUrl", OutputValue: "http://example.com:8080" },
    ]);
    expect(JSON.parse(json)).toEqual({
      FrontendUrl: "http://example.com",
      ApiUrl: "http://example.com:8080",
    });
  });

  it("should return the empty-object JSON for an empty array", () => {
    expect(serializeStackOutputs([])).toBe("{}");
  });

  it("should return the empty-object JSON for undefined", () => {
    expect(serializeStackOutputs(undefined)).toBe("{}");
  });

  it("should skip entries missing OutputKey or OutputValue", () => {
    const json = serializeStackOutputs([
      { OutputKey: "FrontendUrl", OutputValue: "http://example.com" },
      { OutputKey: undefined, OutputValue: "x" },
      { OutputKey: "OnlyKey" },
    ]);
    expect(JSON.parse(json)).toEqual({ FrontendUrl: "http://example.com" });
  });
});

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
