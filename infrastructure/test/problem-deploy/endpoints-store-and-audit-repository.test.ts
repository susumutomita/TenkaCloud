import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeRepositories,
  createCompetitorAccountsRepository,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/repository";
import { queryOverrides } from "../../lib/problem-deploy/handlers/problem-endpoints-handler/store";

/**
 * Issue #1418: 残っていた 2 つの小さな service-module 分岐を pin する。
 * - problem-endpoints-handler/store.ts queryOverrides の `out.Items ?? []` (no-Items) 枝。
 * - external-id-audit-handler/repository.ts composeRepositories の cache miss / hit 両枝。
 */
afterEach(() => vi.clearAllMocks());

describe("queryOverrides", () => {
  it("should return the queried items", async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValue({ Items: [{ PK: "p", SK: "SLOT#a", overrideUrl: "https://x" }] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal DynamoDBDocumentClient for the call.
    } as any;
    const out = await queryOverrides(ddb, "T", "tenant", "team", "p1");
    expect(out).toHaveLength(1);
    // The PK/SK condition is built from the (tenant, team, problem) tuple.
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it("should default to [] when the query returns no Items", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal client.
    const ddb = { send: vi.fn().mockResolvedValue({}) } as any;
    expect(await queryOverrides(ddb, "T", "tenant", "team", "p1")).toEqual([]);
  });
});

describe("composeRepositories", () => {
  it("should build both repositories and memoize the result across calls", () => {
    const first = composeRepositories();
    expect(first.competitorAccounts).toBeDefined();
    expect(first.rotationAgeMetrics).toBeDefined();
    // Module-scope cache: a second call returns the same instance (warm-invoke reuse).
    expect(composeRepositories()).toBe(first);
  });

  it("scanPage should default items to [] when the scan returns no Items", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal client.
    const ddb = { send: vi.fn().mockResolvedValue({}) } as any;
    const page = await createCompetitorAccountsRepository(ddb).scanPage({
      tableName: "T",
      cursor: undefined,
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
