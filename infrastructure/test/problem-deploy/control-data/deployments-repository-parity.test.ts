import { describe, expect, it } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import { hashLoginKey } from "../../../lib/problem-deploy/control-data/teams-repository";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsRepository,
  InboxEventRecord,
  ScoreEventRecord,
  SqlExecutor,
} from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

const TABLE = "Deployments";
const AT = "2026-07-08T12:00:00.000Z";
const EXPIRES = 4_102_444_800;

interface Backend {
  readonly name: string;
  readonly repo: DeploymentsRepository;
  readonly sql?: SqlExecutor;
}

const backends: ReadonlyArray<readonly [string, () => Backend]> = [
  [
    "DynamoDbDeploymentsRepository",
    () => ({
      name: "DynamoDbDeploymentsRepository",
      repo: new DynamoDbDeploymentsRepository(makeFakeDdb(), TABLE),
    }),
  ],
  [
    "SqlDeploymentsRepository",
    () => {
      const sql = makeSqliteExecutor();
      return { name: "SqlDeploymentsRepository", repo: new SqlDeploymentsRepository(sql), sql };
    },
  ],
];

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
    expiresAt: EXPIRES,
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
    expiresAt: EXPIRES,
    teamName: "alpha",
    teamLoginKey: "KEY-A",
    ...overrides,
  };
}

function compositeTarget(
  overrides: Partial<CompositeTargetDeploymentRecord> = {},
): CompositeTargetDeploymentRecord {
  return {
    ...deployment({ jobId: "target-1", teamLoginKey: "KEY-A" }),
    parentDeploymentId: "parent-1",
    targetId: "web",
    targetOrdinal: 1,
    runtimeProvider: "aws",
    runtimeEngine: "cloudformation",
    runtimeEntry: "template.yaml",
    ...overrides,
  };
}

function stripLoginKey<T extends Record<string, unknown>>(record: T | undefined): unknown {
  if (!record) return record;
  const { teamLoginKey: _teamLoginKey, solvedFlagIds, ...rest } = record;
  return {
    ...rest,
    ...(solvedFlagIds instanceof Set ? { solvedFlagIds: [...solvedFlagIds].sort() } : {}),
  };
}

async function expectOutcome(
  promise: Promise<DeploymentMutationOutcome>,
  outcome: DeploymentMutationOutcome["outcome"],
): Promise<DeploymentMutationOutcome> {
  const result = await promise;
  expect(result.outcome).toBe(outcome);
  return result;
}

async function drain<T>(
  run: (onPage: (items: readonly T[]) => Promise<void>) => Promise<void>,
): Promise<T[]> {
  const rows: T[] = [];
  await run(async (items) => {
    rows.push(...items);
  });
  return rows;
}

describe.each(backends)("DeploymentsRepository parity: %s", (_label, makeBackend) => {
  it("should round-trip every read method through the repository contract", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(
      deployment({
        jobId: "a",
        status: "COMPLETE",
        eventId: "ev-1",
        teamId: "t1",
        problemId: "p1",
        score: 10,
        createdAt: "2026-07-01T00:00:00.000Z",
        displayTeamName: "Alpha",
      }),
    );
    await repo.putDeployment(
      deployment({
        jobId: "b",
        status: "IN_PROGRESS",
        eventId: "ev-1",
        teamId: "t2",
        problemId: "p1",
        namePrefix: "shared",
        createdAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    await repo.putDeployment(
      deployment({
        jobId: "c",
        status: "COMPLETE",
        eventId: "ev-2",
        teamId: "t3",
        problemId: "p2",
        teamLoginKey: "KEY-C",
        createdAt: "2026-07-03T00:00:00.000Z",
      }),
    );
    await expectOutcome(
      repo.putCompositeTarget(compositeTarget({ jobId: "t1", targetId: "api" })),
      "updated",
    );
    await expectOutcome(
      repo.putCompositeTarget(compositeTarget({ jobId: "t2", targetId: "web", targetOrdinal: 2 })),
      "updated",
    );
    await repo.appendScoreEvent(scoreEvent({ jobId: "a", occurredAt: "2026-07-04T00:00:00.000Z" }));
    await repo.appendScoreEvent(scoreEvent({ jobId: "a", occurredAt: "2026-07-05T00:00:00.000Z" }));
    await repo.appendInboxEvent("a", "01INBOXIDXXXXXXXXXXXXXXXXX", inboxEvent());
    await expectOutcome(
      repo.writeCoordinationState("tenant-a", "ev-1", { turn: 1 }, 0, AT),
      "updated",
    );

    expect(stripLoginKey(await repo.getDeployment("a"))).toMatchObject({
      jobId: "a",
      status: "COMPLETE",
    });
    expect(stripLoginKey(await repo.queryDeploymentMeta("a"))).toMatchObject({ jobId: "a" });
    expect(
      (await repo.listByTenantPage("tenant-a", { limit: 2 })).items.map((r) => r.jobId),
    ).toEqual(["c", "b"]);
    expect(await repo.countActiveByTenant("tenant-a", ["COMPLETE", "IN_PROGRESS"])).toBe(3);
    expect(await repo.countActiveByTenant("tenant-a", ["COMPLETE"], { stopAtCount: 1 })).toBe(2);
    expect((await repo.listByTenantAndEvent("tenant-a", "ev-1")).map((r) => r.jobId)).toEqual([
      "a",
      "b",
    ]);
    expect(await repo.listDeploymentKeysByEvent("tenant-a", "ev-1")).toEqual(["a", "b"]);
    expect(await repo.listReconcilerRowsByEvent("tenant-a", "ev-1")).toEqual([
      { jobId: "a", status: "COMPLETE", updatedAt: "2026-07-01T00:00:00.000Z" },
      { jobId: "b", status: "IN_PROGRESS", updatedAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(
      (await repo.listByEventTeamProblem("tenant-a", "ev-1", "t1", "p1")).map((r) => r.jobId),
    ).toEqual(["a"]);
    expect(await repo.findByNamePrefix("tenant-a", "shared")).toEqual([
      { namePrefix: "shared", jobId: "b", status: "IN_PROGRESS" },
    ]);
    expect((await repo.listDeploymentSummariesByTenant("tenant-a")).map((r) => r.jobId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect((await repo.listByTeamLoginKey("KEY-A")).map((r) => r.jobId)).toEqual(["a", "b"]);
    expect((await repo.listCompositeTargets("parent-1")).map((r) => r.jobId)).toEqual(["t1", "t2"]);
    expect(
      (await repo.listScoreEvents("a", { pageSize: 1, maxPages: 1 })).map((r) => r.occurredAt),
    ).toEqual(["2026-07-05T00:00:00.000Z"]);
    expect(
      (await repo.listScoreEventsInRange("a", "EVENT#2026-07-04", "EVENT#~")).map(
        (r) => r.occurredAt,
      ),
    ).toEqual(["2026-07-05T00:00:00.000Z", "2026-07-04T00:00:00.000Z"]);
    expect(await repo.listInboxEventsInRange("a", "INBOX#2026-07-01", "INBOX#~")).toEqual([
      inboxEvent(),
    ]);
    expect(await repo.readCoordinationState("tenant-a", "ev-1")).toEqual({
      state: { turn: 1 },
      version: 1,
    });
  });

  it("should return the same row sets for the five forEach*Page scan contracts", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(
      deployment({ jobId: "complete-a", status: "COMPLETE", eventId: "ev-1" }),
    );
    await repo.putDeployment(
      deployment({ jobId: "complete-b", status: "COMPLETE", eventId: "ev-2" }),
    );
    await repo.putDeployment(
      deployment({ jobId: "runtime-a", runtimeProvider: "sakura", status: "IN_PROGRESS" }),
    );
    await expectOutcome(repo.putCompositeParent(compositeParent({ jobId: "parent-a" })), "updated");
    await expectOutcome(
      repo.putCompositeParent(compositeParent({ jobId: "parent-delete", status: "DELETING" })),
      "updated",
    );

    expect(
      (await drain<DeploymentRecord>((onPage) => repo.forEachCompleteDeploymentPage(onPage)))
        .map((r) => r.jobId)
        .sort(),
    ).toEqual(["complete-a", "complete-b"]);
    expect(
      (
        await drain<DeploymentRecord>((onPage) =>
          repo.forEachCompositeDeployReconcilablePage(onPage),
        )
      ).map((r) => r.jobId),
    ).toEqual(["parent-a"]);
    expect(
      (
        await drain<DeploymentRecord>((onPage) => repo.forEachCompositeTeardownPendingPage(onPage))
      ).map((r) => r.jobId),
    ).toEqual(["parent-delete"]);
    expect(
      (await drain<DeploymentRecord>((onPage) => repo.forEachRuntimeReconcilablePage(onPage))).map(
        (r) => r.jobId,
      ),
    ).toEqual(["runtime-a"]);
  });

  it("should preserve conditional write outcomes for status and tenant mutations", async () => {
    const { repo } = makeBackend();
    const cases = [
      {
        seed: deployment({ jobId: "fail", status: "PENDING" }),
        ok: () => repo.markFailedIfPending("fail", "tenant-a", "failed", AT, 100),
        conflict: () => repo.markFailedIfPending("fail", "tenant-a", "failed", AT, 100),
      },
      {
        seed: deployment({ jobId: "retry", status: "FAILED", failureReason: "old" }),
        ok: () => repo.retryToPending("retry", "tenant-a", AT),
        conflict: () => repo.retryToPending("retry", "tenant-a", AT),
      },
      {
        seed: deployment({ jobId: "comp-retry", status: "PENDING" }),
        ok: () => repo.compensateRetryToFailed("comp-retry", "tenant-a", "bad", AT, 100),
        conflict: () => repo.compensateRetryToFailed("comp-retry", "tenant-a", "bad", AT, 100),
      },
      {
        seed: deployment({ jobId: "delete", status: "COMPLETE" }),
        ok: () => repo.markDeleting("delete", "tenant-a", AT, 100),
        conflict: () => repo.markDeleting("delete", "tenant-b", AT, 100),
      },
      {
        seed: deployment({ jobId: "comp-delete", status: "DELETING" }),
        ok: () => repo.compensateDeleteToFailed("comp-delete", "tenant-a", "bad", AT, 100),
        conflict: () => repo.compensateDeleteToFailed("comp-delete", "tenant-a", "bad", AT, 100),
      },
      {
        seed: deployment({ jobId: "approval", status: "PENDING" }),
        ok: () => repo.markApprovalPending("approval", "tenant-a", AT),
        conflict: () => repo.markApprovalPending("approval", "tenant-a", AT),
      },
      {
        seed: deployment({ jobId: "bulk-delete", status: "FAILED" }),
        ok: () => repo.markDeletingForBulk("bulk-delete", "tenant-a", AT),
        conflict: () => repo.markDeletingForBulk("bulk-delete", "tenant-b", AT),
      },
      {
        seed: deployment({ jobId: "bulk-comp", status: "DELETING" }),
        ok: () => repo.compensateBulkTeardown("bulk-comp", "tenant-a", AT),
        conflict: () => repo.compensateBulkTeardown("bulk-comp", "tenant-a", AT),
      },
      {
        seed: deployment({ jobId: "bulk-create-comp", status: "PENDING" }),
        ok: () => repo.compensateBulkCreateToFailed("bulk-create-comp", "tenant-a", "bad", AT),
        conflict: () =>
          repo.compensateBulkCreateToFailed("bulk-create-comp", "tenant-a", "bad", AT),
      },
    ];
    for (const entry of cases) {
      await repo.putDeployment(entry.seed);
      await expectOutcome(entry.ok(), "updated");
      await expectOutcome(entry.conflict(), "conflict");
    }

    await repo.putDeployment(deployment({ jobId: "schedule", status: "COMPLETE" }));
    await expectOutcome(
      repo.applySchedulePatch("schedule", "tenant-a", { startsAt: "2026-08-01T00:00:00.000Z" }, AT),
      "updated",
    );
    await expectOutcome(repo.applySchedulePatch("schedule", "tenant-b", {}, AT), "not_found");
    await expectOutcome(repo.stampEventEndsAt("schedule", "tenant-a", AT, AT), "updated");
    await expectOutcome(repo.stampEventEndsAt("schedule", "tenant-b", AT, AT), "not_found");
  });

  it("should apply DeployCreate SFN status writes idempotently", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(deployment({ jobId: "sfn", status: "PENDING" }));

    await expectOutcome(repo.markCreateInProgress("sfn", AT), "updated");
    await expectOutcome(repo.markCreateInProgress("sfn", AT), "updated");
    expect(await repo.getDeployment("sfn")).toMatchObject({
      status: "IN_PROGRESS",
      updatedAt: AT,
    });

    await expectOutcome(
      repo.markCreateSucceeded(
        "sfn",
        "arn:aws:cloudformation:stack/sfn/1",
        '[{"OutputKey":"Url"}]',
        "build-1",
        AT,
      ),
      "updated",
    );
    expect(await repo.getDeployment("sfn")).toMatchObject({
      status: "COMPLETE",
      stackId: "arn:aws:cloudformation:stack/sfn/1",
      stackOutputs: '[{"OutputKey":"Url"}]',
      buildId: "build-1",
    });

    await expectOutcome(
      repo.markCreateSucceeded("sfn", "arn:aws:cloudformation:stack/sfn/2", "[]", undefined, AT),
      "updated",
    );
    expect(await repo.getDeployment("sfn")).toMatchObject({
      stackId: "arn:aws:cloudformation:stack/sfn/2",
      stackOutputs: "[]",
      buildId: "build-1",
    });

    await expectOutcome(repo.markCreateFailed("sfn", "rollback", undefined, AT), "updated");
    expect(await repo.getDeployment("sfn")).toMatchObject({
      status: "FAILED",
      failureReason: "rollback",
      buildId: "build-1",
    });

    await expectOutcome(repo.markCreateFailed("sfn", "build failed", "build-2", AT), "updated");
    expect(await repo.getDeployment("sfn")).toMatchObject({
      status: "FAILED",
      failureReason: "build failed",
      buildId: "build-2",
    });
  });

  it("[Issue #2441 Phase B PR-6] should apply DeployDelete's MarkDeleted idempotently and clear the login-key index", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(
      deployment({ jobId: "delete-sfn", status: "DELETING", teamLoginKey: "KEY-DELETE" }),
    );
    expect((await repo.listByTeamLoginKey("KEY-DELETE")).map((r) => r.jobId)).toEqual([
      "delete-sfn",
    ]);

    await expectOutcome(repo.markDeleted("delete-sfn", AT), "updated");
    expect(await repo.getDeployment("delete-sfn")).toMatchObject({
      status: "DELETED",
      updatedAt: AT,
    });
    // GSI2 (DDB: REMOVE GSI2PK/GSI2SK) / login_key_hash (SQL) must be cleared so the deleted
    // deployment no longer resolves via the participant-login-key lookup.
    expect(await repo.listByTeamLoginKey("KEY-DELETE")).toEqual([]);

    // At-least-once SFN retry: re-applying MarkDeleted stays idempotent.
    await expectOutcome(repo.markDeleted("delete-sfn", AT), "updated");
  });

  it("should preserve scoring and generic write outcome branches", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(deployment({ jobId: "flag", score: 0, wrongAnswerCount: 0 }));
    const correct = await expectOutcome(repo.applyFlagCorrectScore("flag", 10, AT), "updated");
    expect(correct.outcome === "updated" && correct.record?.score).toBe(10);
    await expectOutcome(repo.applyFlagCorrectScore("flag", 10, AT), "conflict");

    await repo.putDeployment(deployment({ jobId: "wrong", score: 5, wrongAnswerCount: 0 }));
    await expectOutcome(repo.applyFlagWrongPenalty("wrong", 2, AT), "updated");
    await expectOutcome(repo.applyFlagCorrectScore("wrong", 10, AT), "updated");
    await expectOutcome(repo.applyFlagWrongPenalty("wrong", 2, AT), "conflict");

    await repo.putDeployment(
      deployment({ jobId: "multi", score: 0, solvedFlagIds: new Set(["a"]) }),
    );
    await expectOutcome(repo.applyMultiFlagCorrectScore("multi", 5, "b", AT), "updated");
    await expectOutcome(repo.applyMultiFlagCorrectScore("multi", 5, "b", AT), "conflict");
    await repo.putDeployment(deployment({ jobId: "multi-wrong", score: 0 }));
    await expectOutcome(repo.applyMultiFlagWrongPenalty("multi-wrong", 2, "b", AT), "updated");
    await expectOutcome(repo.applyMultiFlagCorrectScore("multi-wrong", 5, "b", AT), "updated");
    await expectOutcome(repo.applyMultiFlagWrongPenalty("multi-wrong", 2, "b", AT), "conflict");

    const hint = { hintId: "h1", revealedAt: AT, penaltyApplied: 4 };
    await repo.putDeployment(deployment({ jobId: "hint", score: 10 }));
    await expectOutcome(repo.applyHintPenalty("hint", hint, AT), "updated");
    await expectOutcome(repo.applyHintPenalty("hint", hint, AT), "conflict");

    await expectOutcome(repo.updateDisplayTeamName("hint", "Renamed", AT), "updated");
    expect((await repo.getDeployment("hint"))?.displayTeamName).toBe("Renamed");
    await expectOutcome(
      repo.applyKindScoringResult("hint", { scoreDelta: 2, newState: { n: 1 } }, AT),
      "updated",
    );
    await expectOutcome(repo.setScoringState("hint", '{"ok":true}', AT), "updated");

    await expectOutcome(
      repo.putCompositeParent(compositeParent({ jobId: "parent-cas" })),
      "updated",
    );
    await expectOutcome(
      repo.casCompositeParentStatus("parent-cas", "PENDING", "IN_PROGRESS", AT),
      "updated",
    );
    await expectOutcome(
      repo.casCompositeParentStatus("parent-cas", "PENDING", "COMPLETE", AT),
      "conflict",
    );
    await expectOutcome(repo.latchGateCompleted("hint", AT), "updated");
    await expectOutcome(repo.latchGateCompleted("hint", AT), "conflict");
    await repo.putDeployment(deployment({ jobId: "stuck", status: "DELETING" }));
    await expectOutcome(repo.markStuckDeletingFailed("stuck", "stuck", AT), "updated");
    await expectOutcome(repo.markStuckDeletingFailed("stuck", "stuck", AT), "conflict");
    await repo.putDeployment(deployment({ jobId: "stuck-pending", status: "PENDING" }));
    await expectOutcome(
      repo.markStuckCreatingFailed("stuck-pending", "stuck create", AT),
      "updated",
    );
    await expectOutcome(
      repo.markStuckCreatingFailed("stuck-pending", "stuck create", AT),
      "conflict",
    );
    await repo.putDeployment(deployment({ jobId: "stuck-progress", status: "IN_PROGRESS" }));
    await expectOutcome(
      repo.markStuckCreatingFailed("stuck-progress", "stuck create", AT),
      "updated",
    );
    await repo.putDeployment(deployment({ jobId: "already-complete", status: "COMPLETE" }));
    await expectOutcome(
      repo.markStuckCreatingFailed("already-complete", "stuck create", AT),
      "conflict",
    );
    await repo.putDeployment(deployment({ jobId: "runtime", status: "IN_PROGRESS" }));
    await expectOutcome(
      repo.transitionRuntimeStatus("runtime", "tenant-a", "IN_PROGRESS", "COMPLETE", "{}", AT),
      "updated",
    );
    await expectOutcome(
      repo.transitionRuntimeStatus("runtime", "tenant-a", "IN_PROGRESS", "COMPLETE", undefined, AT),
      "conflict",
    );
  });

  it("should keep transaction-style writes all-or-nothing", async () => {
    const { repo } = makeBackend();
    await repo.putDeployment(
      deployment({ jobId: "gate", score: 10, eventId: "ev-1", teamId: "t1" }),
    );
    await expectOutcome(
      repo.awardGateBonusAtomic(
        { jobId: "gate", problemId: "p1", teamId: "t1", eventId: "ev-1", expiresAt: EXPIRES },
        25,
        AT,
      ),
      "updated",
    );
    expect((await repo.getDeployment("gate"))?.score).toBe(35);
    expect(await repo.listScoreEvents("gate", { pageSize: 10 })).toHaveLength(1);
    await expectOutcome(
      repo.awardGateBonusAtomic(
        { jobId: "gate", problemId: "p1", teamId: "t1", eventId: "ev-1", expiresAt: EXPIRES },
        25,
        AT,
      ),
      "conflict",
    );
    expect(await repo.listScoreEvents("gate", { pageSize: 10 })).toHaveLength(1);

    await repo.putDeployment(deployment({ jobId: "old", status: "FAILED" }));
    await expectOutcome(
      repo.createBulkDeployments("tenant-a", [
        {
          record: deployment({ jobId: "bulk-new", eventId: "ev-1", teamId: "t1" }),
          replacesJobId: "old",
        },
      ]),
      "updated",
    );
    expect(await repo.getDeployment("old")).toBeUndefined();
    expect(await repo.getDeployment("bulk-new")).toBeDefined();

    await repo.putDeployment(deployment({ jobId: "old-foreign", tenantId: "tenant-b" }));
    await expectOutcome(
      repo.createBulkDeployments("tenant-a", [
        { record: deployment({ jobId: "bulk-conflict" }), replacesJobId: "old-foreign" },
      ]),
      "conflict",
    );
    expect(await repo.getDeployment("bulk-conflict")).toBeUndefined();
    expect(await repo.getDeployment("old-foreign")).toBeDefined();
  });

  it("should append sub-aggregate rows and enforce coordination optimistic locking", async () => {
    const { repo } = makeBackend();
    const score = scoreEvent({ jobId: "score-target" });
    await repo.appendScoreEvent(score);
    expect(await repo.listScoreEvents("score-target", { pageSize: 10 })).toEqual([score]);

    const inbox = inboxEvent();
    await repo.appendInboxEvent("inbox-target", "01INBOXIDXXXXXXXXXXXXXXXXX", inbox);
    expect(
      await repo.listInboxEventsInRange("inbox-target", "INBOX#2026-07-01", "INBOX#~"),
    ).toEqual([inbox]);

    await expectOutcome(
      repo.writeCoordinationState("tenant-a", "ev-lock", { turn: 1 }, 0, AT),
      "updated",
    );
    await expectOutcome(
      repo.writeCoordinationState("tenant-a", "ev-lock", { turn: 2 }, 0, AT),
      "conflict",
    );
    expect(await repo.readCoordinationState("tenant-a", "ev-lock")).toEqual({
      state: { turn: 1 },
      version: 1,
    });
    await expectOutcome(
      repo.writeCoordinationState("tenant-a", "ev-lock", { turn: 2 }, 1, AT),
      "updated",
    );
    expect(await repo.readCoordinationState("tenant-a", "ev-lock")).toEqual({
      state: { turn: 2 },
      version: 2,
    });
  });
});

describe("SqlDeploymentsRepository login-key storage", () => {
  it("should store only the SHA-256 login-key hash and scrub plaintext payloads", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDeploymentsRepository(sql);
    const plaintext = "PLAINTEXT-DEPLOYMENT-KEY";
    await repo.putDeployment(deployment({ jobId: "secret", teamLoginKey: plaintext }));

    const row = await sql.get("SELECT login_key_hash, payload FROM deployments WHERE job_id = ?", [
      "secret",
    ]);
    expect(row?.login_key_hash).toBe(hashLoginKey(plaintext));
    expect(row?.login_key_hash).not.toBe(plaintext);
    expect(String(row?.payload)).not.toContain(plaintext);
    expect(JSON.parse(String(row?.payload))).not.toHaveProperty("teamLoginKey");
    expect((await repo.listByTeamLoginKey(plaintext))[0]?.teamLoginKey).toBe(plaintext);
  });

  it("should preserve a pre-hashed team credential without ever receiving plaintext", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDeploymentsRepository(sql);
    const plaintext = "ONE-TIME-CREATE-RESPONSE-KEY";
    const prehashed = hashLoginKey(plaintext);
    const record = deployment({ jobId: "prehashed" });
    delete record.teamLoginKey;
    record.teamLoginKeyHash = prehashed;

    await repo.putDeployment(record);

    const row = await sql.get("SELECT login_key_hash, payload FROM deployments WHERE job_id = ?", [
      "prehashed",
    ]);
    expect(row?.login_key_hash).toBe(prehashed);
    expect(String(row?.payload)).not.toContain(prehashed);
    expect(JSON.parse(String(row?.payload))).not.toHaveProperty("teamLoginKeyHash");
    expect((await repo.listByTeamLoginKey(plaintext))[0]?.jobId).toBe("prehashed");
  });

  it("should reject ambiguous plaintext and pre-hashed credentials", async () => {
    const repo = new SqlDeploymentsRepository(makeSqliteExecutor());
    await expect(
      repo.putDeployment(
        deployment({
          jobId: "ambiguous",
          teamLoginKey: "PLAINTEXT",
          teamLoginKeyHash: hashLoginKey("PLAINTEXT"),
        }),
      ),
    ).rejects.toThrow("plaintext or pre-hashed login credential, not both");
  });

  it("should reject malformed pre-hashed credentials", async () => {
    const repo = new SqlDeploymentsRepository(makeSqliteExecutor());
    const record = deployment({ jobId: "malformed" });
    delete record.teamLoginKey;
    record.teamLoginKeyHash = "not-a-sha256-hash";

    await expect(repo.putDeployment(record)).rejects.toThrow("valid SHA-256 login credential");
  });
});

describe("DynamoDbDeploymentsRepository login-key storage", () => {
  it("should reject a hash-only credential that cannot populate the plaintext GSI", async () => {
    const repo = new DynamoDbDeploymentsRepository(makeFakeDdb(), TABLE);
    const record = deployment({ jobId: "hash-only" });
    delete record.teamLoginKey;
    record.teamLoginKeyHash = hashLoginKey("PLAINTEXT");

    await expect(repo.putDeployment(record)).rejects.toThrow(
      "DynamoDB deployments require a plaintext login credential",
    );
  });
});

function scoreEvent(overrides: Partial<ScoreEventRecord> = {}): ScoreEventRecord {
  return {
    jobId: "j1",
    problemId: "p1",
    teamId: "t1",
    eventId: "ev-1",
    source: "uptime",
    points: 10,
    result: "ok",
    occurredAt: "2026-07-04T00:00:00.000Z",
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function inboxEvent(overrides: Partial<InboxEventRecord> = {}): InboxEventRecord {
  return {
    eventId: "ev-1",
    fromTeamId: "team-2",
    fromJobId: "sender-1",
    kind: "sabotage",
    payload: { amount: 1 },
    occurredAt: "2026-07-04T00:00:00.000Z",
    ttl: EXPIRES,
    ...overrides,
  };
}
