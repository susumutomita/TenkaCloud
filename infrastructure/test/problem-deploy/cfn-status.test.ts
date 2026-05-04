import { describe, expect, it } from "vitest";
import {
  resolveDeploymentStatus,
  serializeStackOutputs,
} from "../../lib/problem-deploy/handlers/shared/cfn-status";

describe("resolveDeploymentStatus", () => {
  it("CREATE_COMPLETE → COMPLETE 遷移を返すべき", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "CREATE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "COMPLETE",
    });
  });

  it("UPDATE_COMPLETE も COMPLETE 扱いするべき", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "UPDATE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "COMPLETE",
    });
  });

  it("CREATE_FAILED → FAILED + reason を埋め込むべき", () => {
    const r = resolveDeploymentStatus("IN_PROGRESS", "CREATE_FAILED", "VPC limit exceeded");
    expect(r).toEqual({
      kind: "transition",
      status: "FAILED",
      failureReason: "CREATE_FAILED: VPC limit exceeded",
    });
  });

  it("ROLLBACK_COMPLETE → FAILED に倒すべき", () => {
    const r = resolveDeploymentStatus("IN_PROGRESS", "ROLLBACK_COMPLETE", undefined);
    expect(r).toEqual({ kind: "transition", status: "FAILED", failureReason: "ROLLBACK_COMPLETE" });
  });

  it("DELETE_COMPLETE → DELETED 遷移を返すべき", () => {
    expect(resolveDeploymentStatus("DELETING", "DELETE_COMPLETE", undefined)).toEqual({
      kind: "transition",
      status: "DELETED",
    });
  });

  it("既に COMPLETE なら CREATE_COMPLETE で再遷移しないべき (二重発火防止)", () => {
    expect(resolveDeploymentStatus("COMPLETE", "CREATE_COMPLETE", undefined)).toEqual({
      kind: "stable",
    });
  });

  it("CREATE_IN_PROGRESS は stable (内部 IN_PROGRESS を維持)", () => {
    expect(resolveDeploymentStatus("IN_PROGRESS", "CREATE_IN_PROGRESS", undefined)).toEqual({
      kind: "stable",
    });
  });

  it("未知の StackStatus は stable で安全側に倒すべき", () => {
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
  it("Outputs を OutputKey -> OutputValue の JSON にすべき", () => {
    const json = serializeStackOutputs([
      { OutputKey: "FrontendUrl", OutputValue: "http://example.com" },
      { OutputKey: "ApiUrl", OutputValue: "http://example.com:8080" },
    ]);
    expect(JSON.parse(json)).toEqual({
      FrontendUrl: "http://example.com",
      ApiUrl: "http://example.com:8080",
    });
  });

  it("空配列は空オブジェクトの JSON を返すべき", () => {
    expect(serializeStackOutputs([])).toBe("{}");
  });

  it("undefined は空オブジェクトの JSON を返すべき", () => {
    expect(serializeStackOutputs(undefined)).toBe("{}");
  });

  it("OutputKey か OutputValue が欠けたエントリはスキップするべき", () => {
    const json = serializeStackOutputs([
      { OutputKey: "FrontendUrl", OutputValue: "http://example.com" },
      { OutputKey: undefined, OutputValue: "x" },
      { OutputKey: "OnlyKey" },
    ]);
    expect(JSON.parse(json)).toEqual({ FrontendUrl: "http://example.com" });
  });
});
