import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTenantFeatureEnabled,
  readTenantFeatureFlags,
  tenantFlagsKey,
} from "../../lib/problem-deploy/handlers/shared/tenant-feature-flags";

/**
 * Issue #2283: per-tenant feature-flag 行の共有 reader。
 * event-handler (getFeatureFlags) / participant-handler (challenge access guard) /
 * generic-scoring-handler (Gate 完了 bonus) が同じ判定を使う。
 */

const send = vi.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;

beforeEach(() => vi.clearAllMocks());

describe("tenantFlagsKey", () => {
  it("should build the TENANT#<id>/FLAGS key used by the admin write path", () => {
    expect(tenantFlagsKey("t-1")).toEqual({ PK: "TENANT#t-1", SK: "FLAGS" });
  });
});

describe("readTenantFeatureFlags", () => {
  it("should read the flags row from the events table", async () => {
    send.mockResolvedValueOnce({ Item: { flags: { challengePrerequisiteGate: true } } });

    const flags = await readTenantFeatureFlags(ddb, "TestEvents", "t-1");

    expect(flags).toEqual({ challengePrerequisiteGate: true });
    const cmd = send.mock.calls[0]?.[0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input.TableName).toBe("TestEvents");
    expect(cmd.input.Key).toEqual({ PK: "TENANT#t-1", SK: "FLAGS" });
  });

  it("should return {} when the tenant never saved overrides", async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await readTenantFeatureFlags(ddb, "TestEvents", "t-1")).toEqual({});
  });

  it("should throw on a DDB error (caller decides the failure semantics)", async () => {
    send.mockRejectedValueOnce(new Error("ddb boom"));
    await expect(readTenantFeatureFlags(ddb, "TestEvents", "t-1")).rejects.toThrow("ddb boom");
  });
});

describe("isTenantFeatureEnabled", () => {
  it("should return true only when the flag is explicitly true", async () => {
    send.mockResolvedValueOnce({ Item: { flags: { challengePrerequisiteGate: true } } });
    expect(await isTenantFeatureEnabled(ddb, "T", "t-1", "challengePrerequisiteGate")).toBe(true);
  });

  it("should default to false when the flag key is absent (default OFF)", async () => {
    send.mockResolvedValueOnce({ Item: { flags: { redTeam: true } } });
    expect(await isTenantFeatureEnabled(ddb, "T", "t-1", "challengePrerequisiteGate")).toBe(false);
  });

  it("should default to false when no flags row exists", async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await isTenantFeatureEnabled(ddb, "T", "t-1", "challengePrerequisiteGate")).toBe(false);
  });

  it("should treat a read error as OFF (opt-in feature must not block competition ops)", async () => {
    send.mockRejectedValueOnce(new Error("ddb boom"));
    expect(await isTenantFeatureEnabled(ddb, "T", "t-1", "challengePrerequisiteGate")).toBe(false);
  });
});
