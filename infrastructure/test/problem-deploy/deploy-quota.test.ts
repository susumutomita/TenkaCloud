import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DeployQuotaExceededError,
  enforceDeployQuota,
  parseDeployQuota,
  resolveQuotaTier,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy-quota";

/**
 * Issue #1766: tier 別の同時デプロイクォータ。
 * 受け入れ条件の 3 ケース (上限内 / 超過 / tier 不明) + env parse の loud-fail を pin する。
 */

function ctxWithTier(tier?: string): Context {
  return {
    env: {
      event: {
        requestContext: {
          authorizer: { jwt: { claims: tier ? { "custom:tenantTier": tier } : {} } },
        },
      },
    },
  } as unknown as Context;
}

const QUOTA = { basic: 2, advanced: 5, platinum: 10 };

function depsWithActiveCount(count: number) {
  const send = vi.fn().mockResolvedValue({ Count: count });
  return { deps: { ddb: { send }, tableName: "TestDeployments", quota: QUOTA }, send };
}

describe("parseDeployQuota (#1766)", () => {
  it("should return undefined (quota disabled) when the env is unset or empty", () => {
    expect(parseDeployQuota(undefined)).toBeUndefined();
    expect(parseDeployQuota("")).toBeUndefined();
    expect(parseDeployQuota("  ")).toBeUndefined();
  });

  it("should parse a complete tier map", () => {
    expect(parseDeployQuota('{"basic":2,"advanced":5,"platinum":10}')).toEqual(QUOTA);
  });

  it.each([
    ["null", "null"],
    ["array", "[1,2,3]"],
    ["string", '"basic"'],
    ["not json", "{basic:2}"],
    ["missing tier", '{"basic":2,"advanced":5}'],
    ["negative", '{"basic":-1,"advanced":5,"platinum":10}'],
    ["non-integer", '{"basic":1.5,"advanced":5,"platinum":10}'],
  ])("should throw loudly on a broken value (%s) instead of silently disabling", (_label, raw) => {
    expect(() => parseDeployQuota(raw)).toThrow(/DEPLOY_QUOTA_BY_TIER/);
  });
});

describe("resolveQuotaTier (#1766)", () => {
  it.each([
    ["advanced", "advanced"],
    ["ADVANCED", "advanced"],
    ["platinum", "platinum"],
    ["PLATINUM", "platinum"],
    ["basic", "basic"],
  ])("should map claim %s to tier %s", (claim, expected) => {
    expect(resolveQuotaTier(ctxWithTier(claim))).toBe(expected);
  });

  it("should fall back to basic (most restrictive) for an unknown tier value", () => {
    expect(resolveQuotaTier(ctxWithTier("GOLD"))).toBe("basic");
  });

  it("should fall back to basic when the claim is absent", () => {
    expect(resolveQuotaTier(ctxWithTier(undefined))).toBe("basic");
  });
});

describe("enforceDeployQuota (#1766)", () => {
  it("should accept when active deployments are below the tier limit", async () => {
    const { deps, send } = depsWithActiveCount(1);
    await expect(enforceDeployQuota(deps, "tenant-a", "basic")).resolves.toBeUndefined();
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-a");
    expect(cmd.input.Select).toBe("COUNT");
  });

  it("should throw DeployQuotaExceededError when active deployments reach the limit", async () => {
    const { deps } = depsWithActiveCount(2);
    await expect(enforceDeployQuota(deps, "tenant-a", "basic")).rejects.toMatchObject({
      name: "DeployQuotaExceededError",
      tier: "basic",
      limit: 2,
      active: 2,
    });
  });

  it("should apply the per-tier limit (advanced allows more than basic)", async () => {
    const { deps } = depsWithActiveCount(2);
    await expect(enforceDeployQuota(deps, "tenant-a", "advanced")).resolves.toBeUndefined();
  });

  it("should be a no-op when quota is undefined (env not wired = legacy stacks / Lite)", async () => {
    const send = vi.fn();
    await expect(
      enforceDeployQuota(
        { ddb: { send }, tableName: "TestDeployments", quota: undefined },
        "tenant-a",
        "basic",
      ),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("should sum counts across pages and stop early once the limit is reached", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: { PK: "x" } })
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: { PK: "y" } });
    const deps = { ddb: { send }, tableName: "TestDeployments", quota: QUOTA };
    await expect(enforceDeployQuota(deps, "tenant-a", "basic")).rejects.toBeInstanceOf(
      DeployQuotaExceededError,
    );
    // 2 page 目で limit=2 に到達 → 3 page 目は読まない (RCU 節約)。
    expect(send).toHaveBeenCalledTimes(2);
  });
});
