import { describe, expect, it } from "vitest";
import {
  DynamoDbProblemEndpointsRepository,
  SqlProblemEndpointsRepository,
} from "../../../lib/problem-deploy/control-data/problem-endpoints-repository";
import type {
  ProblemEndpointRecord,
  ProblemEndpointsRepository,
} from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C1] Cross-backend parity suite for the ProblemEndpoints
 * seam: the same test body runs against {@link DynamoDbProblemEndpointsRepository}
 * and {@link SqlProblemEndpointsRepository}, pinning that a caller sees identical
 * domain behavior regardless of `CONTROL_DATA_BACKEND` (mirrors
 * `deployments-repository-parity.test.ts`).
 */

const TABLE = "ProblemEndpoints";

interface Backend {
  readonly name: string;
  readonly repo: ProblemEndpointsRepository;
}

const backends: ReadonlyArray<readonly [string, () => Backend]> = [
  [
    "DynamoDbProblemEndpointsRepository",
    () => ({
      name: "DynamoDbProblemEndpointsRepository",
      repo: new DynamoDbProblemEndpointsRepository(makeFakeDdb(), TABLE),
    }),
  ],
  [
    "SqlProblemEndpointsRepository",
    () => ({
      name: "SqlProblemEndpointsRepository",
      repo: new SqlProblemEndpointsRepository(makeSqliteExecutor()),
    }),
  ],
];

function record(over: Partial<ProblemEndpointRecord> = {}): ProblemEndpointRecord {
  return {
    tenantId: "tenant-a",
    teamId: "team-1",
    problemId: "p1",
    slot: "frontend",
    overrideUrl: "https://team.example.com/",
    updatedAt: "2026-07-08T12:00:00.000Z",
    ...over,
  };
}

describe.each(backends)("ProblemEndpointsRepository parity: %s", (_label, makeBackend) => {
  it("should round-trip a put through queryOverrides", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record());

    expect(await repo.queryOverrides("tenant-a", "team-1", "p1")).toEqual([record()]);
  });

  it("should return [] for a (tenant, team, problem) triple with no rows", async () => {
    const { repo } = makeBackend();
    expect(await repo.queryOverrides("tenant-x", "team-x", "px")).toEqual([]);
  });

  it("should upsert on a repeat put for the same (tenant, team, problem, slot)", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record({ overrideUrl: "https://old.example.com/" }));
    await repo.putOverride(record({ overrideUrl: "https://new.example.com/" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([record({ overrideUrl: "https://new.example.com/" })]);
  });

  it("should scope rows to the exact (tenant, team, problem) triple — no cross-team / cross-problem leakage", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record({ slot: "frontend" }));
    await repo.putOverride(record({ teamId: "team-2", slot: "frontend" }));
    await repo.putOverride(record({ problemId: "p2", slot: "frontend" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([record({ slot: "frontend" })]);
  });

  it("should return every slot for the same (tenant, team, problem) triple", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record({ slot: "frontend" }));
    await repo.putOverride(record({ slot: "api" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows.map((r) => r.slot).sort()).toEqual(["api", "frontend"]);
  });

  it("should delete an override row idempotently (delete-then-delete is a no-op)", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record());

    await repo.deleteOverride("tenant-a", "team-1", "p1", "frontend");
    expect(await repo.queryOverrides("tenant-a", "team-1", "p1")).toEqual([]);

    // A second delete of the same key must not throw (idempotent).
    await expect(
      repo.deleteOverride("tenant-a", "team-1", "p1", "frontend"),
    ).resolves.toBeUndefined();
  });

  it("should delete only the targeted slot, leaving sibling slots intact", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(record({ slot: "frontend" }));
    await repo.putOverride(record({ slot: "api" }));

    await repo.deleteOverride("tenant-a", "team-1", "p1", "frontend");

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([record({ slot: "api" })]);
  });

  it("should round-trip optional fields (defaultCacheUrl / platform) without dropping them", async () => {
    const { repo } = makeBackend();
    await repo.putOverride(
      record({ defaultCacheUrl: "https://cache.example.com/", platform: "linux" }),
    );

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([
      record({ defaultCacheUrl: "https://cache.example.com/", platform: "linux" }),
    ]);
  });
});
