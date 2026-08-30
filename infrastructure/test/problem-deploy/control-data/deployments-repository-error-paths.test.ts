import { describe, expect, it } from "vitest";
import {
  type CompositeParentDeploymentRecord,
  type CompositeTargetDeploymentRecord,
  type DeploymentRecord,
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import {
  DynamoDbDeploymentsCore,
  isTransactConditionalCheckFailed,
} from "../../../lib/problem-deploy/control-data/dynamodb-deployments-core";
import {
  decodeCursor,
  encodeCursor,
  isUniqueConstraintViolation,
  normalizeJsonValue,
  SqlDeploymentsCore,
} from "../../../lib/problem-deploy/control-data/sql-deployments-core";
import { SqlDeploymentsLifecycle } from "../../../lib/problem-deploy/control-data/sql-deployments-lifecycle";
import { SqlDeploymentsScoring } from "../../../lib/problem-deploy/control-data/sql-deployments-scoring";
import type { SqlExecutor, SqlRow } from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [#2527 Slice 3] Error-path / rarely-hit-branch coverage for the deployments
 * capability adapters (mirrors `events-repository-error-paths.test.ts`). The
 * happy paths stay pinned by the parity + writes suites; this file pins the
 * conflict probes, keyset-cursor decoding, unique-violation folding, and the
 * lost-race branches that only a scripted executor can reach.
 */

const TABLE = "Deployments";
const AT = "2026-07-08T12:00:00.000Z";

function deployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    jobId: "j1",
    tenantId: "tenant-a",
    problemId: "p1",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "alpha",
    namePrefix: "tc-alpha-p1",
    teamLoginKey: "KEY-A",
    status: "PENDING",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

function compositeParent(
  overrides: Partial<CompositeParentDeploymentRecord> = {},
): CompositeParentDeploymentRecord {
  return {
    jobId: "parent-1",
    tenantId: "tenant-a",
    problemId: "composite",
    runtimeKind: "composite",
    compositeVersion: 1,
    targetCount: 2,
    status: "PENDING",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: 4_102_444_800,
    teamName: "alpha",
    teamLoginKey: "KEY-A",
    ...overrides,
  };
}

function compositeTarget(
  overrides: Partial<CompositeTargetDeploymentRecord> = {},
): CompositeTargetDeploymentRecord {
  return {
    ...deployment({ jobId: "target-1" }),
    parentDeploymentId: "parent-1",
    targetId: "web",
    targetOrdinal: 1,
    runtimeProvider: "aws",
    runtimeEngine: "cloudformation",
    runtimeEntry: "template.yaml",
    ...overrides,
  };
}

function makeSqlRepo(): SqlDeploymentsRepository {
  return new SqlDeploymentsRepository(makeSqliteExecutor());
}

function makeDdbRepo(): DynamoDbDeploymentsRepository {
  return new DynamoDbDeploymentsRepository(makeFakeDdb(), TABLE);
}

/**
 * Scripted executor for lost-race branches: the row read succeeds but the
 * guarded UPDATE matches zero rows (another writer won in between). A real
 * SQLite handle cannot produce this interleaving inside one test.
 */
function scriptedExecutor(opts: {
  readonly row?: SqlRow;
  readonly runChanges?: number;
  readonly allRows?: readonly SqlRow[];
  readonly batchError?: Error;
}): SqlExecutor {
  return {
    run: () => ({ changes: opts.runChanges ?? 0 }),
    get: () => opts.row,
    all: () => [...(opts.allRows ?? [])],
    batch: () => {
      if (opts.batchError) throw opts.batchError;
      return [];
    },
  };
}

function payloadRow(record: Record<string, unknown>): SqlRow {
  return { payload: JSON.stringify(record), tenant_id: String(record.tenantId ?? "") };
}

describe("SqlDeploymentsComposite error paths", () => {
  it("should fail a PENDING composite target and record the failure reason", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeTarget(compositeTarget());
    const outcome = await repo.failCompositeTargetIfPending("target-1", "quota exceeded", AT);
    expect(outcome.outcome).toBe("updated");
    const record = await repo.getDeployment("target-1");
    expect(record?.status).toBe("FAILED");
    expect((record as { failureReason?: string })?.failureReason).toBe("quota exceeded");
  });

  it("should return conflict when failing a composite target that is not PENDING", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeTarget(compositeTarget({ status: "COMPLETE" }));
    const outcome = await repo.failCompositeTargetIfPending("target-1", "too late", AT);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should return conflict when failing a missing composite target", async () => {
    const outcome = await makeSqlRepo().failCompositeTargetIfPending("nope", "missing", AT);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should mark a composite parent DELETING exactly once", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeParent(compositeParent());
    const first = await repo.markCompositeParentDeleting("parent-1", AT);
    expect(first.outcome).toBe("updated");
    expect((await repo.getDeployment("parent-1"))?.status).toBe("DELETING");
    const second = await repo.markCompositeParentDeleting("parent-1", AT);
    expect(second).toEqual({ outcome: "conflict" });
  });

  it("should return conflict when marking a missing composite parent DELETING", async () => {
    const outcome = await makeSqlRepo().markCompositeParentDeleting("nope", AT);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should probe a duplicate composite parent back to conflict with the stored record", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeParent(compositeParent());
    const outcome = await repo.putCompositeParent(compositeParent());
    expect(outcome.outcome).toBe("conflict");
    expect((outcome as { record?: CompositeParentDeploymentRecord }).record?.jobId).toBe(
      "parent-1",
    );
  });

  it("should probe a duplicate composite parent of another tenant to not_found", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeParent(compositeParent());
    const outcome = await repo.putCompositeParent(compositeParent({ tenantId: "tenant-b" }));
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should return conflict for a duplicate composite target without probing", async () => {
    const repo = makeSqlRepo();
    await repo.putCompositeTarget(compositeTarget());
    const outcome = await repo.putCompositeTarget(compositeTarget());
    expect(outcome).toEqual({ outcome: "conflict" });
  });
});

describe("SqlDeploymentsLifecycle error paths", () => {
  it("should replace the prior deployment atomically in createBulkDeployments", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "old-1" }));
    const outcome = await repo.createBulkDeployments("tenant-a", [
      { record: deployment({ jobId: "new-1" }), replacesJobId: "old-1" },
    ]);
    expect(outcome).toEqual({ outcome: "updated" });
    expect(await repo.getDeployment("old-1")).toBeUndefined();
    expect((await repo.getDeployment("new-1"))?.jobId).toBe("new-1");
  });

  it("should return conflict when replacesJobId does not exist", async () => {
    const outcome = await makeSqlRepo().createBulkDeployments("tenant-a", [
      { record: deployment({ jobId: "new-1" }), replacesJobId: "ghost" },
    ]);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should return conflict when replacesJobId belongs to another tenant", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "old-1", tenantId: "tenant-b" }));
    const outcome = await repo.createBulkDeployments("tenant-a", [
      { record: deployment({ jobId: "new-1" }), replacesJobId: "old-1" },
    ]);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should return conflict when a bulk-create entry collides with an existing jobId", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "dup-1" }));
    const outcome = await repo.createBulkDeployments("tenant-a", [
      { record: deployment({ jobId: "dup-1" }) },
    ]);
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it.each([
    ["SQL", makeSqlRepo] as const,
    ["DynamoDB", makeDdbRepo] as const,
  ])("should return updated for an empty bulk-create entry list (%s)", async (_label, make) => {
    const outcome = await make().createBulkDeployments("tenant-a", []);
    expect(outcome).toEqual({ outcome: "updated" });
  });

  it("should return not_found when marking create in progress on a missing job", async () => {
    const outcome = await makeSqlRepo().markCreateInProgress("ghost", AT);
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should keep stackOutputs untouched when transitionRuntimeStatus passes none", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "rt-1", status: "IN_PROGRESS" }));
    const outcome = await repo.transitionRuntimeStatus(
      "rt-1",
      "tenant-a",
      "IN_PROGRESS",
      "COMPLETE",
      undefined,
      AT,
    );
    expect(outcome.outcome).toBe("updated");
    const record = await repo.getDeployment("rt-1");
    expect(record?.status).toBe("COMPLETE");
    expect((record as { stackOutputs?: string })?.stackOutputs).toBeUndefined();
  });

  it("should rethrow a non-unique bulk-create batch failure", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ batchError: new Error("database is locked") }),
    );
    await expect(
      new SqlDeploymentsLifecycle(core).createBulkDeployments("tenant-a", [
        { record: deployment({ jobId: "new-1" }) },
      ]),
    ).rejects.toThrow("database is locked");
  });

  it("should fold a lost UPDATE race in markDeleted into not_found", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment()), runChanges: 0 }),
    );
    const outcome = await new SqlDeploymentsLifecycle(core).markDeleted("j1", AT);
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should fold a lost UPDATE race in markCreateInProgress into not_found", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment()), runChanges: 0 }),
    );
    const outcome = await new SqlDeploymentsLifecycle(core).markCreateInProgress("j1", AT);
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should fold a lost guarded-UPDATE race in transitionRuntimeStatus into conflict", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment({ status: "IN_PROGRESS" })), runChanges: 0 }),
    );
    const outcome = await new SqlDeploymentsLifecycle(core).transitionRuntimeStatus(
      "j1",
      "tenant-a",
      "IN_PROGRESS",
      "COMPLETE",
      undefined,
      AT,
    );
    expect(outcome).toEqual({ outcome: "conflict" });
  });
});

describe("SqlDeploymentsQuery keyset pagination", () => {
  async function seedThree(repo: SqlDeploymentsRepository): Promise<void> {
    await repo.putDeployment(
      deployment({ jobId: "a", createdAt: "2026-07-01T00:00:01.000Z", teamLoginKey: undefined }),
    );
    await repo.putDeployment(
      deployment({ jobId: "b", createdAt: "2026-07-01T00:00:02.000Z", teamLoginKey: undefined }),
    );
    await repo.putDeployment(
      deployment({ jobId: "c", createdAt: "2026-07-01T00:00:03.000Z", teamLoginKey: undefined }),
    );
  }

  it("should page newest-first and resume exactly after the cursor", async () => {
    const repo = makeSqlRepo();
    await seedThree(repo);
    const first = await repo.listByTenantPage("tenant-a", { limit: 2 });
    expect(first.items.map((r) => r.jobId)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeDefined();
    const second = await repo.listByTenantPage("tenant-a", {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.jobId)).toEqual(["a"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("should restart from the first page on a malformed cursor", async () => {
    const repo = makeSqlRepo();
    await seedThree(repo);
    const page = await repo.listByTenantPage("tenant-a", { limit: 3, cursor: "not-base64-json" });
    expect(page.items.map((r) => r.jobId)).toEqual(["c", "b", "a"]);
  });

  it("should count zero active deployments for an empty status list", async () => {
    const repo = makeSqlRepo();
    await seedThree(repo);
    expect(await repo.countActiveByTenant("tenant-a", [])).toBe(0);
  });
});

describe("DynamoDbDeploymentsQuery paging and point reads", () => {
  it("should return undefined from queryDeploymentMeta for a missing job", async () => {
    expect(await makeDdbRepo().queryDeploymentMeta("ghost")).toBeUndefined();
  });

  it("should hand back a resumable cursor when the tenant listing overflows the page", async () => {
    const repo = makeDdbRepo();
    await repo.putDeployment(deployment({ jobId: "a", createdAt: "2026-07-01T00:00:01.000Z" }));
    await repo.putDeployment(deployment({ jobId: "b", createdAt: "2026-07-01T00:00:02.000Z" }));
    await repo.putDeployment(deployment({ jobId: "c", createdAt: "2026-07-01T00:00:03.000Z" }));
    const first = await repo.listByTenantPage("tenant-a", { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await repo.listByTenantPage("tenant-a", {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.jobId)).toEqual(["a"]);
  });
});

describe("SqlDeploymentsScoring error paths", () => {
  it("should apply every optional field of a kind-scoring result", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "s1", score: 10 }));
    const outcome = await repo.applyKindScoringResult(
      "s1",
      {
        scoreDelta: 5,
        lastResult: "ok",
        endpointsHealthJson: '{"web":"ok"}',
        attackProbesJson: '{"probe":1}',
        postureJson: '{"posture":"hardened"}',
        platform: "aws",
        newState: { attackCount: 2 },
      },
      AT,
    );
    expect(outcome.outcome).toBe("updated");
    const record = (await repo.getDeployment("s1")) as Record<string, unknown>;
    expect(record.score).toBe(15);
    expect(record.lastResult).toBe("ok");
    expect(record.endpointsHealth).toBe('{"web":"ok"}');
    expect(record.attackProbes).toBe('{"probe":1}');
    expect(record.posture).toBe('{"posture":"hardened"}');
    expect(record.platform).toBe("aws");
    expect(record.scoringState).toBe(JSON.stringify({ attackCount: 2 }));
  });

  it("should leave the score untouched for a zero-delta kind-scoring result", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "s2", score: 10 }));
    const outcome = await repo.applyKindScoringResult("s2", { scoreDelta: 0 }, AT);
    expect(outcome.outcome).toBe("updated");
    expect((await repo.getDeployment("s2"))?.score).toBe(10);
  });

  it("should return conflict when awarding a gate bonus to a missing parent", async () => {
    const outcome = await makeSqlRepo().awardGateBonusAtomic(
      { jobId: "ghost", problemId: "p1", teamId: "t1", eventId: "e1", expiresAt: undefined },
      10,
      AT,
    );
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should award a gate bonus exactly once", async () => {
    const repo = makeSqlRepo();
    await repo.putDeployment(deployment({ jobId: "g1", score: 0, teamId: "t1", eventId: "e1" }));
    const parent = {
      jobId: "g1",
      problemId: "p1",
      teamId: "t1",
      eventId: "e1",
      expiresAt: undefined,
    };
    const first = await repo.awardGateBonusAtomic(parent, 25, AT);
    expect(first).toEqual({ outcome: "updated" });
    expect((await repo.getDeployment("g1"))?.score).toBe(25);
    const second = await repo.awardGateBonusAtomic(parent, 25, AT);
    expect(second).toEqual({ outcome: "conflict" });
  });

  it("should fold a unique-violation during the gate-bonus batch into conflict", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({
        row: payloadRow(deployment({ jobId: "g1" })),
        batchError: new Error("UNIQUE constraint failed: deployment_score_events"),
      }),
    );
    const outcome = await new SqlDeploymentsScoring(core).awardGateBonusAtomic(
      { jobId: "g1", problemId: "p1", teamId: "t1", eventId: "e1", expiresAt: 0 },
      10,
      AT,
    );
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should rethrow a non-unique gate-bonus batch failure", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({
        row: payloadRow(deployment({ jobId: "g1" })),
        batchError: new Error("disk I/O error"),
      }),
    );
    await expect(
      new SqlDeploymentsScoring(core).awardGateBonusAtomic(
        { jobId: "g1", problemId: "p1", teamId: "t1", eventId: "e1", expiresAt: 0 },
        10,
        AT,
      ),
    ).rejects.toThrow("disk I/O error");
  });

  it("should fold a lost withPostImage race in applyHintPenalty into conflict", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment()), runChanges: 0, allRows: [] }),
    );
    const outcome = await new SqlDeploymentsScoring(core).applyHintPenalty(
      "j1",
      { hintId: "h1", revealedAt: AT, penaltyApplied: 5 },
      AT,
    );
    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it.each([
    ["SQL", makeSqlRepo] as const,
    ["DynamoDB", makeDdbRepo] as const,
  ])("should return no score events when maxPages is zero (%s)", async (_label, make) => {
    const repo = make();
    await repo.putDeployment(deployment({ jobId: "se-1" }));
    expect(await repo.listScoreEvents("se-1", { pageSize: 5, maxPages: 0 })).toEqual([]);
  });

  it.each([
    ["SQL", makeSqlRepo] as const,
    ["DynamoDB", makeDdbRepo] as const,
  ])("should default a payload-less inbox event to an empty payload (%s)", async (_label, make) => {
    const repo = make();
    await repo.putDeployment(deployment({ jobId: "ib-1" }));
    await repo.appendInboxEvent("ib-1", "01ULID", {
      eventId: "e1",
      fromTeamId: "t2",
      fromJobId: "j2",
      kind: "cast",
      occurredAt: AT,
    });
    const events = await repo.listInboxEventsInRange("ib-1", "INBOX#", "INBOX#￿");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("cast");
    expect(events[0]?.payload).toEqual({});
  });
});

describe("SqlDeploymentsCoordination", () => {
  /** [Issue #3123] Every port call names all four namespace dimensions. */
  const COORD_SCOPE = {
    tenantId: "tenant-a",
    eventId: "e1",
    problemId: "problem-a",
    runId: "default",
  } as const;

  it("should read undefined before any coordination state is written", async () => {
    expect(await makeSqlRepo().readCoordinationState(COORD_SCOPE)).toBeUndefined();
  });

  it("should roundtrip state and reject a stale version", async () => {
    const repo = makeSqlRepo();
    const write = await repo.writeCoordinationState(COORD_SCOPE, { phase: 1 }, 0, AT, 0);
    expect(write).toEqual({ outcome: "updated" });
    const read = await repo.readCoordinationState(COORD_SCOPE);
    expect(read).toEqual({ state: { phase: 1 }, version: 1 });
    const stale = await repo.writeCoordinationState(COORD_SCOPE, { phase: 2 }, 0, AT, 0);
    expect(stale).toEqual({ outcome: "conflict" });
  });

  /**
   * [Issue #3123] The SQL mirror of the DynamoDB isolation test: one event,
   * two problems, two runs — four independent rows, none of which sees the
   * others' state or version.
   */
  it("should isolate state by problem and by run inside one event", async () => {
    const repo = makeSqlRepo();
    const targets = [
      { ...COORD_SCOPE, problemId: "problem-a", runId: "run-1" },
      { ...COORD_SCOPE, problemId: "problem-b", runId: "run-1" },
      { ...COORD_SCOPE, problemId: "problem-a", runId: "run-2" },
    ];
    for (const [index, target] of targets.entries()) {
      expect(await repo.writeCoordinationState(target, { phase: index }, 0, AT, 0)).toEqual({
        outcome: "updated",
      });
    }
    for (const [index, target] of targets.entries()) {
      expect(await repo.readCoordinationState(target)).toEqual({
        state: { phase: index },
        version: 1,
      });
    }
  });

  /**
   * [Issue #3123] Cleanup is idempotent and removes exactly one namespace —
   * a retried teardown converges instead of erroring, and a sibling problem
   * still mid-match keeps its state.
   */
  it("should delete one namespace idempotently without touching a sibling", async () => {
    const repo = makeSqlRepo();
    const doomed = { ...COORD_SCOPE, problemId: "problem-a" };
    const survivor = { ...COORD_SCOPE, problemId: "problem-b" };
    await repo.writeCoordinationState(doomed, { phase: 1 }, 0, AT, 0);
    await repo.writeCoordinationState(survivor, { phase: 2 }, 0, AT, 0);

    await repo.deleteCoordinationState(doomed);
    await repo.deleteCoordinationState(doomed);

    expect(await repo.readCoordinationState(doomed)).toBeUndefined();
    expect(await repo.readCoordinationState(survivor)).toEqual({
      state: { phase: 2 },
      version: 1,
    });
  });

  /**
   * [Issue #3123] The retention backstop for a namespace no teardown ever
   * deleted. SQLite has no native TTL, so the sweep is what reaps here; rows
   * still inside their window, and rows written without a TTL, are left alone.
   */
  it("should sweep only rows whose TTL has passed", async () => {
    const repo = makeSqlRepo();
    const expired = { ...COORD_SCOPE, problemId: "problem-expired" };
    const live = { ...COORD_SCOPE, problemId: "problem-live" };
    const untimed = { ...COORD_SCOPE, problemId: "problem-untimed" };
    await repo.writeCoordinationState(expired, { phase: 1 }, 0, AT, 1000);
    await repo.writeCoordinationState(live, { phase: 2 }, 0, AT, 5000);
    await repo.writeCoordinationState(untimed, { phase: 3 }, 0, AT, 0);

    expect(await repo.sweepExpiredCoordinationState(2000)).toBe(1);

    expect(await repo.readCoordinationState(expired)).toBeUndefined();
    expect(await repo.readCoordinationState(live)).toMatchObject({ state: { phase: 2 } });
    expect(await repo.readCoordinationState(untimed)).toMatchObject({ state: { phase: 3 } });
  });
});

describe("SqlDeploymentsCore engine branches", () => {
  it("should probe a mutation miss to conflict when the record still belongs to the tenant", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment()), runChanges: 1 }),
    );
    const outcome = await core.mutateExisting({
      jobId: "j1",
      predicate: () => false,
      mutate: () => {},
      onMiss: { probeTenantId: "tenant-a" },
    });
    expect(outcome.outcome).toBe("conflict");
    expect((outcome as { record?: DeploymentRecord }).record?.jobId).toBe("j1");
  });

  it("should probe a mutation miss to not_found when the row is gone", async () => {
    const core = new SqlDeploymentsCore(scriptedExecutor({}));
    const outcome = await core.mutateExisting({
      jobId: "j1",
      predicate: () => true,
      mutate: () => {},
      onMiss: { probeTenantId: "tenant-a" },
    });
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should rethrow a non-unique insert failure instead of folding it", async () => {
    const failingRun: SqlExecutor = {
      ...scriptedExecutor({}),
      run: () => {
        throw new Error("database is locked");
      },
    };
    await expect(
      new SqlDeploymentsCore(failingRun).conditionalInsert(deployment(), "conflict"),
    ).rejects.toThrow("database is locked");
  });

  it("should fold a lost withPostImage race into the onMiss outcome", async () => {
    const core = new SqlDeploymentsCore(
      scriptedExecutor({ row: payloadRow(deployment()), allRows: [] }),
    );
    const outcome = await core.mutateExisting({
      jobId: "j1",
      predicate: () => true,
      mutate: () => {},
      onMiss: "not_found",
      withPostImage: true,
    });
    expect(outcome).toEqual({ outcome: "not_found" });
  });
});

describe("DynamoDbDeploymentsCore engine branches", () => {
  it("should probe a conditional-update failure back through the tenant", async () => {
    const ddb = makeFakeDdb();
    const repo = new DynamoDbDeploymentsRepository(ddb, TABLE);
    await repo.putDeployment(deployment());
    const core = new DynamoDbDeploymentsCore(ddb, TABLE);
    const failingUpdate = {
      UpdateExpression: "SET #s = :s",
      ConditionExpression: "#s = :never",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "FAILED", ":never": "NO-SUCH-STATUS" },
    };
    const sameTenant = await core.conditionalUpdate("j1", failingUpdate, {
      probeTenantId: "tenant-a",
    });
    expect(sameTenant.outcome).toBe("conflict");
    const otherTenant = await core.conditionalUpdate("j1", failingUpdate, {
      probeTenantId: "tenant-b",
    });
    expect(otherTenant).toEqual({ outcome: "not_found" });
    const missing = await core.conditionalUpdate("ghost", failingUpdate, {
      probeTenantId: "tenant-a",
    });
    expect(missing).toEqual({ outcome: "not_found" });
  });

  it("should map a conditional-update failure straight to not_found when told to", async () => {
    const core = new DynamoDbDeploymentsCore(makeFakeDdb(), TABLE);
    const outcome = await core.conditionalUpdate(
      "ghost",
      {
        UpdateExpression: "SET #s = :s",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "FAILED" },
      },
      "not_found",
    );
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should treat an ALL_NEW update without attributes as not_found", () => {
    expect(DynamoDbDeploymentsCore.updatedFrom(undefined)).toEqual({ outcome: "not_found" });
  });
});

describe("pure helper branches", () => {
  it("should decode only well-formed keyset cursors", () => {
    const cursor = encodeCursor({ createdAt: AT, jobId: "j1" });
    expect(decodeCursor(cursor)).toEqual({ createdAt: AT, jobId: "j1" });
    expect(decodeCursor("@@not-base64-json@@")).toBeUndefined();
    expect(decodeCursor(Buffer.from("42", "utf8").toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from("null", "utf8").toString("base64url"))).toBeUndefined();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ createdAt: AT }), "utf8").toString("base64url")),
    ).toBeUndefined();
  });

  it("should recognize every unique-constraint violation shape", () => {
    expect(isUniqueConstraintViolation("boom")).toBe(false);
    expect(isUniqueConstraintViolation(new Error("disk I/O error"))).toBe(false);
    expect(
      isUniqueConstraintViolation(new Error("UNIQUE constraint failed: deployments.job_id")),
    ).toBe(true);
    const withCode = new Error("constraint") as Error & { code?: string };
    withCode.code = "SQLITE_CONSTRAINT_PRIMARYKEY";
    expect(isUniqueConstraintViolation(withCode)).toBe(true);
    const withExtended = new Error("constraint") as Error & { extendedCode?: string };
    withExtended.extendedCode = "SQLITE_CONSTRAINT_UNIQUE";
    expect(isUniqueConstraintViolation(withExtended)).toBe(true);
  });

  it("should normalize Sets, arrays, and undefined-valued keys for the payload", () => {
    expect(normalizeJsonValue(new Set(["a", "b"]))).toEqual(["a", "b"]);
    expect(normalizeJsonValue([{ keep: 1, drop: undefined }])).toEqual([{ keep: 1 }]);
    expect(normalizeJsonValue(null)).toBeNull();
    expect(normalizeJsonValue("text")).toBe("text");
  });

  it("should only match transaction cancellations that carry a conditional failure", () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "TransactionCanceledException";
    expect(isTransactConditionalCheckFailed(cancelled)).toBe(false);
    const withReasons = new Error("cancelled") as Error & {
      CancellationReasons?: Array<{ Code?: string }>;
    };
    withReasons.name = "TransactionCanceledException";
    withReasons.CancellationReasons = [{ Code: "None" }, { Code: "ConditionalCheckFailed" }];
    expect(isTransactConditionalCheckFailed(withReasons)).toBe(true);
    expect(isTransactConditionalCheckFailed(new Error("other"))).toBe(false);
  });
});
