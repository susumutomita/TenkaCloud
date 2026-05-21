import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  type ExternalIdStoreDeps,
  getExternalIdByVersion,
  getExternalIdWithVersion,
} from "../../lib/problem-deploy/handlers/shared/external-id-store";

// Phase 3.2 / Issue #603: rotate 直後の grace fallback のための SSM Parameter Store version 系
// helper のユニットテスト。

function buildDeps(): { deps: ExternalIdStoreDeps; ssmSend: ReturnType<typeof vi.fn> } {
  const ssmSend = vi.fn();
  const deps: ExternalIdStoreDeps = {
    ssm: { send: ssmSend } as unknown as ExternalIdStoreDeps["ssm"],
    env: "development",
  };
  return { deps, ssmSend };
}

describe("getExternalIdWithVersion", () => {
  it("should return Value + Version as a pair", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockResolvedValueOnce({
      Parameter: { Value: "current-external-id", Version: 7 },
    });
    const out = await getExternalIdWithVersion(deps, "tenant-acme");
    expect(out).toEqual({ value: "current-external-id", version: 7 });
    const cmd = ssmSend.mock.calls[0]?.[0] as GetParameterCommand;
    expect(cmd).toBeInstanceOf(GetParameterCommand);
    expect(cmd.input.Name).toBe("/development/tenants/tenant-acme/external-id");
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it("should return undefined on ParameterNotFound", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }));
    const out = await getExternalIdWithVersion(deps, "tenant-acme");
    expect(out).toBeUndefined();
  });

  it("should return undefined when Value or Version is missing", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "only-value" } });
    const out = await getExternalIdWithVersion(deps, "tenant-acme");
    expect(out).toBeUndefined();
  });
});

describe("getExternalIdByVersion", () => {
  it("should fetch a previous version by appending `:<version>` to Name", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "old-external-id" } });
    const value = await getExternalIdByVersion(deps, "tenant-acme", 6);
    expect(value).toBe("old-external-id");
    const cmd = ssmSend.mock.calls[0]?.[0] as GetParameterCommand;
    expect(cmd.input.Name).toBe("/development/tenants/tenant-acme/external-id:6");
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it("should return undefined without hitting SSM when version <= 0 (no rotation yet / no 1-generation-back)", async () => {
    const { deps, ssmSend } = buildDeps();
    expect(await getExternalIdByVersion(deps, "tenant-acme", 0)).toBeUndefined();
    expect(await getExternalIdByVersion(deps, "tenant-acme", -1)).toBeUndefined();
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("should return undefined on ParameterNotFound", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }));
    const value = await getExternalIdByVersion(deps, "tenant-acme", 6);
    expect(value).toBeUndefined();
  });

  it("should also return undefined on ParameterVersionNotFound (auto-dropped at the 100-version cap)", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockRejectedValueOnce(
      Object.assign(new Error("version dropped"), { name: "ParameterVersionNotFound" }),
    );
    const value = await getExternalIdByVersion(deps, "tenant-acme", 1);
    expect(value).toBeUndefined();
  });

  it("should re-throw other errors (no swallowing fallbacks)", async () => {
    const { deps, ssmSend } = buildDeps();
    ssmSend.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "Throttling" }));
    await expect(getExternalIdByVersion(deps, "tenant-acme", 6)).rejects.toThrow("throttled");
  });
});
