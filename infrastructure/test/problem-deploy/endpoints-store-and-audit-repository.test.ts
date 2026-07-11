import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeRepositories,
  createCompetitorAccountsRepository,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/repository";
import { queryOverrides } from "../../lib/problem-deploy/handlers/problem-endpoints-handler/store";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

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
    const out = await queryOverrides(
      makeTestControlDataRuntime(),
      ddb,
      "T",
      "tenant",
      "team",
      "p1",
    );
    expect(out).toHaveLength(1);
    // The PK/SK condition is built from the (tenant, team, problem) tuple.
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it("should default to [] when the query returns no Items", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal client.
    const ddb = { send: vi.fn().mockResolvedValue({}) } as any;
    expect(
      await queryOverrides(makeTestControlDataRuntime(), ddb, "T", "tenant", "team", "p1"),
    ).toEqual([]);
  });
});

describe("composeRepositories", () => {
  it("should build both repositories on each call, given a tableName", () => {
    // [Issue #2442 / Phase C2] `tableName` is now a per-invoke input (resolved from env at
    // `handler()` call time, not module load, since pure SQL backends synth no table at all) —
    // `composeRepositories` rebuilds the thin repository wrapper on every call, while the
    // expensive DynamoDBDocumentClient / CloudWatchClient constructors stay memoized at module
    // scope (`cachedDdb` / `cachedCloudWatch`) so warm invokes still reuse the same socket pool.
    const first = composeRepositories(makeTestControlDataRuntime(), "T");
    expect(first.competitorAccounts).toBeDefined();
    expect(first.rotationAgeMetrics).toBeDefined();
    const second = composeRepositories(makeTestControlDataRuntime(), "T");
    expect(second.competitorAccounts).toBeDefined();
    expect(second.rotationAgeMetrics).toBeDefined();
  });

  it("forEachAccountPage should call onPage with [] when the scan returns no Items", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal client.
    const ddb = { send: vi.fn().mockResolvedValue({}) } as any;
    const onPage = vi.fn().mockResolvedValue(undefined);

    await createCompetitorAccountsRepository({
      runtime: makeTestControlDataRuntime(),
      ddb,
      tableName: "T",
    }).forEachAccountPage(onPage);

    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([]);
  });
});
