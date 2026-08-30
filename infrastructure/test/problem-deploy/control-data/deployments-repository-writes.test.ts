import {
  type DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  type CompositeParentDeploymentRecord,
  type CompositeTargetDeploymentRecord,
  type DeploymentMutationOutcome,
  type DeploymentRecord,
  DynamoDbDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import { makeFakeDdb } from "./control-data-write.test-helpers";

/**
 * [Issue #2441 / Phase B2] Deployment write seam source map:
 * - deploy-handler/deploy.ts:262 -> putDeployment
 * - deploy-handler/deploy.ts:344 -> markFailedIfPending
 * - deploy-handler/retry.ts:154 -> retryToPending
 * - deploy-handler/retry.ts:237 -> compensateRetryToFailed
 * - deploy-handler/delete.ts:214 -> markDeleting
 * - deploy-handler/delete.ts:270 -> compensateDeleteToFailed
 * - deploy-handler/cloud-action-enforcement.ts:189 -> markApprovalPending
 * - deploy-handler/composite-dispatch.ts:128 -> failCompositeTargetIfPending
 * - deploy-handler/composite-teardown.ts:104 -> markCompositeParentDeleting
 * - deploy-handler/composite-repository.ts:167 -> putCompositeParent
 * - deploy-handler/composite-repository.ts:246 -> putCompositeTarget
 * - participant-handler/submit-flag.ts:163 -> applyMultiFlagCorrectScore
 * - participant-handler/submit-flag.ts:205 -> applyMultiFlagWrongPenalty
 * - participant-handler/submit-flag.ts:302 -> applyFlagWrongPenalty
 * - participant-handler/submit-flag.ts:328 -> applyFlagCorrectScore
 * - participant-handler/reveal-hint.ts:174 -> applyHintPenalty
 * - participant-handler/update.ts:62 -> updateDisplayTeamName
 * - generic-scoring-handler/apply-kind-result.ts:28 -> applyKindScoringResult
 * - generic-scoring-handler/composite-status-reconciler.ts:112 -> casCompositeParentStatus
 * - generic-scoring-handler/composite-teardown-reconciler.ts:112 -> casCompositeParentStatus
 * - generic-scoring-handler/gate-completion-bonus.ts:105 -> latchGateCompleted
 * - generic-scoring-handler/gate-completion-bonus.ts:139 -> awardGateBonusAtomic
 * - generic-scoring-handler/condition-disruption-fire.ts:70 -> setScoringState
 * - generic-scoring-handler/event-reconciler.ts:228 -> markStuckDeletingFailed
 * - generic-scoring-handler/runtime-status-reconciler.ts:169 -> transitionRuntimeStatus
 * - event-handler/bulk-delete.ts:157 -> compensateBulkTeardown
 * - event-handler/bulk-delete.ts:237 -> markDeletingForBulk
 * - event-handler/schedule.ts:325 -> applySchedulePatch
 * - event-handler/bulk-deploy/persistence.ts:43 -> createBulkDeployments
 * - event-handler/bulk-deploy/persistence.ts:111 -> compensateBulkCreateToFailed
 * - event-handler/end-event.ts:100 -> stampEventEndsAt
 */

const TABLE = "Deployments";
const AT = "2026-07-08T12:00:00.000Z";
const EXPIRES = 1_783_456_789;

type Item = Record<string, unknown>;

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

function itemFrom(record: DeploymentRecord): Item {
  const item: Item = {
    PK: `DEPLOYMENT#${record.jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${record.tenantId}`,
    GSI1SK: record.createdAt,
    ...record,
  };
  if (record.teamLoginKey) {
    item.GSI2PK = `TEAMKEY#${record.teamLoginKey}`;
    item.GSI2SK = record.createdAt;
  }
  return item;
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

function recording(): {
  readonly repo: DynamoDbDeploymentsRepository;
  readonly ddb: DynamoDBDocumentClient;
  // biome-ignore lint/suspicious/noExplicitAny: raw AWS SDK Command capture.
  readonly commands: any[];
  readonly seed: (items: readonly Item[]) => Promise<void>;
  readonly reset: () => void;
} {
  const ddb = makeFakeDdb();
  // biome-ignore lint/suspicious/noExplicitAny: raw AWS SDK Command capture.
  const commands: any[] = [];
  const original = ddb.send.bind(ddb);
  // biome-ignore lint/suspicious/noExplicitAny: wrap the fake send.
  (ddb as any).send = (cmd: any) => {
    commands.push(cmd);
    return original(cmd);
  };
  return {
    repo: new DynamoDbDeploymentsRepository(ddb, TABLE),
    ddb,
    commands,
    seed: async (items) => {
      for (const item of items) await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    },
    reset: () => {
      commands.length = 0;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: raw AWS SDK Command capture.
const updates = (commands: any[]) => commands.filter((cmd) => cmd instanceof UpdateCommand);
// biome-ignore lint/suspicious/noExplicitAny: raw AWS SDK Command capture.
const puts = (commands: any[]) => commands.filter((cmd) => cmd instanceof PutCommand);
// biome-ignore lint/suspicious/noExplicitAny: raw AWS SDK Command capture.
const transacts = (commands: any[]) =>
  commands.filter((cmd) => cmd instanceof TransactWriteCommand);

async function expectOutcome(
  promise: Promise<DeploymentMutationOutcome>,
  outcome: DeploymentMutationOutcome["outcome"],
): Promise<void> {
  await expect(promise).resolves.toMatchObject({ outcome });
}

describe("DynamoDbDeploymentsRepository writes — Put rows", () => {
  it("should put a normal deployment row with GSI1 and sparse GSI2 keys", async () => {
    const { repo, commands } = recording();
    const record = deployment({ jobId: "new-1", teamLoginKey: "LOGIN" });

    await repo.putDeployment(record);

    const put = puts(commands)[0].input;
    expect(put.ConditionExpression).toBeUndefined();
    expect(put.Item).toMatchObject({
      PK: "DEPLOYMENT#new-1",
      SK: "META",
      GSI1PK: "TENANT#tenant-a",
      GSI1SK: record.createdAt,
      GSI2PK: "TEAMKEY#LOGIN",
      GSI2SK: record.createdAt,
    });
    expect(await repo.getDeployment("new-1")).toEqual(record);
  });

  it("should put a composite parent without tenant/team GSIs and probe on conflict", async () => {
    const { repo, seed, reset, commands } = recording();
    const parent = compositeParent();

    await expectOutcome(repo.putCompositeParent(parent), "updated");
    const put = puts(commands)[0].input;
    expect(put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(put.Item).toMatchObject({ PK: "DEPLOYMENT#parent-1", SK: "META" });
    expect(put.Item.GSI1PK).toBeUndefined();
    expect(put.Item.GSI2PK).toBeUndefined();

    await seed([]);
    reset();
    const conflict = await repo.putCompositeParent(parent);
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.outcome === "conflict" && conflict.record?.jobId).toBe("parent-1");
  });

  it("should put a composite target with only GSI3 and return conflict without a probe", async () => {
    const { repo, commands, reset } = recording();
    const target = compositeTarget();

    await expectOutcome(repo.putCompositeTarget(target), "updated");
    const put = puts(commands)[0].input;
    expect(put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(put.Item).toMatchObject({
      PK: "DEPLOYMENT#target-1",
      SK: "META",
      GSI3PK: "PARENT_DEPLOYMENT#parent-1",
      GSI3SK: "ORDINAL#01#TARGET#web",
    });
    expect(put.Item.GSI1PK).toBeUndefined();
    expect(put.Item.GSI2PK).toBeUndefined();

    reset();
    await expectOutcome(repo.putCompositeTarget(target), "conflict");
    expect(puts(commands)).toHaveLength(1);
  });
});

describe("DynamoDbDeploymentsRepository writes — status transitions", () => {
  it("should pin DeployCreate SFN writeback expressions without conditions", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ status: "PENDING" }))]);
    reset();

    await expectOutcome(repo.markCreateInProgress("j1", AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "IN_PROGRESS",
        ":updatedAt": AT,
      },
    });
    expect(updates(commands)[0].input.ConditionExpression).toBeUndefined();
    expect(await repo.getDeployment("j1")).toMatchObject({ status: "IN_PROGRESS" });

    reset();
    await expectOutcome(
      repo.markCreateSucceeded("j1", "stack-1", '[{"OutputKey":"Url"}]', "build-1", AT),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      // [Issue #2946] `completedAt` は `if_not_exists` で一度だけ書く。
      UpdateExpression:
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs" +
        ", completedAt = if_not_exists(completedAt, :completedAt), buildId = :buildId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "COMPLETE",
        ":updatedAt": AT,
        ":stackId": "stack-1",
        ":stackOutputs": '[{"OutputKey":"Url"}]',
        ":buildId": "build-1",
      },
    });

    reset();
    await expectOutcome(repo.markCreateSucceeded("j1", "stack-2", "[]", undefined, AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      // [Issue #2946] buildId 無しの経路でも `completedAt` は書く。
      UpdateExpression:
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs" +
        ", completedAt = if_not_exists(completedAt, :completedAt)",
      ExpressionAttributeValues: {
        ":status": "COMPLETE",
        ":updatedAt": AT,
        ":stackId": "stack-2",
        ":stackOutputs": "[]",
      },
    });
    expect(updates(commands)[0].input.ExpressionAttributeValues[":buildId"]).toBeUndefined();
    expect((await repo.getDeployment("j1"))?.buildId).toBe("build-1");

    reset();
    await expectOutcome(repo.markCreateFailed("j1", "rollback", "build-2", AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason, buildId = :buildId",
      ExpressionAttributeNames: {
        "#status": "status",
        "#failureReason": "failureReason",
      },
      ExpressionAttributeValues: {
        ":status": "FAILED",
        ":updatedAt": AT,
        ":failureReason": "rollback",
        ":buildId": "build-2",
      },
    });

    reset();
    await expectOutcome(repo.markCreateFailed("j1", "lambda failed", undefined, AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason",
      ExpressionAttributeValues: {
        ":status": "FAILED",
        ":updatedAt": AT,
        ":failureReason": "lambda failed",
      },
    });
    expect(updates(commands)[0].input.ExpressionAttributeValues[":buildId"]).toBeUndefined();
    expect((await repo.getDeployment("j1"))?.buildId).toBe("build-2");
  });

  it("should pin deploy/retry/delete/bulk status update expressions and fold CCFs", async () => {
    const cases = [
      {
        name: "markFailedIfPending",
        seed: deployment({ status: "PENDING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.markFailedIfPending("j1", "tenant-a", "publish failed", AT, EXPIRES),
        expression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        condition: "tenantId = :tenantId AND #s = :pending",
        expected: { status: "FAILED", failureReason: "publish failed", expiresAt: EXPIRES },
      },
      {
        name: "retryToPending",
        seed: deployment({ status: "FAILED", failureReason: "old" }),
        run: (repo: DynamoDbDeploymentsRepository) => repo.retryToPending("j1", "tenant-a", AT),
        expression: "SET #s = :pending, updatedAt = :updatedAt REMOVE failureReason",
        condition: "#s = :failed AND tenantId = :tenantId",
        expected: { status: "PENDING" },
        absent: "failureReason",
      },
      {
        name: "compensateRetryToFailed",
        seed: deployment({ status: "PENDING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.compensateRetryToFailed("j1", "tenant-a", "retry publish failed", AT, EXPIRES),
        expression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        condition: "#s = :pending AND tenantId = :tenantId",
        expected: { status: "FAILED", failureReason: "retry publish failed", expiresAt: EXPIRES },
      },
      {
        name: "markDeleting",
        seed: deployment({ status: "COMPLETE" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.markDeleting("j1", "tenant-a", AT, EXPIRES),
        expression:
          "SET #s = :deleting, updatedAt = :updatedAt, expiresAt = :expiresAt, teardownRequestedAt = if_not_exists(teardownRequestedAt, :updatedAt)",
        condition: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        expected: { status: "DELETING", expiresAt: EXPIRES },
      },
      {
        name: "compensateDeleteToFailed",
        seed: deployment({ status: "DELETING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.compensateDeleteToFailed("j1", "tenant-a", "delete publish failed", AT, EXPIRES),
        expression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        condition: "tenantId = :tenantId AND #s = :deleting",
        expected: { status: "FAILED", failureReason: "delete publish failed", expiresAt: EXPIRES },
      },
      {
        name: "markApprovalPending",
        seed: deployment({ status: "PENDING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.markApprovalPending("j1", "tenant-a", AT),
        expression: "SET #s = :approvalPending, updatedAt = :updatedAt",
        condition: "tenantId = :tenantId AND #s = :pending",
        expected: { status: "APPROVAL_PENDING" },
      },
      {
        name: "failCompositeTargetIfPending",
        seed: deployment({ status: "PENDING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.failCompositeTargetIfPending("j1", "preflight failed: Error", AT),
        expression: "SET #s = :failed, failureReason = :reason, updatedAt = :now",
        condition: "#s = :pending",
        expected: { status: "FAILED", failureReason: "preflight failed: Error" },
      },
      {
        name: "markCompositeParentDeleting",
        seed: {
          ...itemFrom(deployment({ jobId: "j1", status: "PENDING" })),
          runtimeKind: "composite",
        },
        run: (repo: DynamoDbDeploymentsRepository) => repo.markCompositeParentDeleting("j1", AT),
        expression:
          "SET #s = :deleting, updatedAt = :now, teardownRequestedAt = if_not_exists(teardownRequestedAt, :now)",
        condition: "runtimeKind = :composite AND #s <> :deleting",
        expected: { status: "DELETING" },
      },
      {
        name: "compensateBulkTeardown",
        seed: deployment({ status: "DELETING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.compensateBulkTeardown("j1", "tenant-a", AT),
        expression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        condition: "tenantId = :tenantId AND #s = :deleting",
        expected: {
          status: "FAILED",
          failureReason: "Failed to publish DeployDeleteRequested event (bulk teardown)",
        },
      },
      {
        name: "markDeletingForBulk",
        seed: deployment({ status: "FAILED" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.markDeletingForBulk("j1", "tenant-a", AT),
        expression:
          "SET #s = :deleting, updatedAt = :updatedAt, teardownRequestedAt = if_not_exists(teardownRequestedAt, :updatedAt)",
        condition: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        expected: { status: "DELETING" },
      },
      {
        name: "compensateBulkCreateToFailed",
        seed: deployment({ status: "PENDING" }),
        run: (repo: DynamoDbDeploymentsRepository) =>
          repo.compensateBulkCreateToFailed("j1", "tenant-a", "Failed to publish event: x", AT),
        expression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        condition: "tenantId = :tenantId AND #s = :pending",
        expected: { status: "FAILED", failureReason: "Failed to publish event: x" },
      },
    ] as const;

    for (const c of cases) {
      const { repo, seed, reset, commands } = recording();
      await seed([typeof c.seed.PK === "string" ? c.seed : itemFrom(c.seed)]);
      reset();

      await expectOutcome(c.run(repo), "updated");

      const input = updates(commands)[0].input;
      expect(input.UpdateExpression, c.name).toBe(c.expression);
      expect(input.ConditionExpression, c.name).toBe(c.condition);
      expect(input.Key, c.name).toEqual({ PK: "DEPLOYMENT#j1", SK: "META" });
      const stored = await repo.getDeployment("j1");
      expect(stored, c.name).toMatchObject({ ...c.expected, updatedAt: AT });
      if ("absent" in c)
        expect(stored?.[c.absent as keyof DeploymentRecord], c.name).toBeUndefined();
      reset();
      await expectOutcome(c.run(repo), "conflict");
    }
  });

  it("should pin tenant-only denormalization writes as not_found on CCF", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ status: "COMPLETE" }))]);
    reset();

    await expectOutcome(
      repo.applySchedulePatch("j1", "tenant-a", { startsAt: "2026-08-01T00:00:00.000Z" }, AT),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET updatedAt = :now, eventStartsAt = :s",
      ConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: {
        ":now": AT,
        ":tenantId": "tenant-a",
        ":s": "2026-08-01T00:00:00.000Z",
      },
    });
    expect((await repo.getDeployment("j1"))?.eventStartsAt).toBe("2026-08-01T00:00:00.000Z");

    reset();
    await expectOutcome(repo.stampEventEndsAt("j1", "tenant-a", AT, AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET eventEndsAt = :e, updatedAt = :now",
      ConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":e": AT, ":now": AT, ":tenantId": "tenant-a" },
    });
    reset();
    await expectOutcome(repo.stampEventEndsAt("j1", "tenant-b", AT, AT), "not_found");
  });
});

describe("DynamoDbDeploymentsRepository writes — participant scoring", () => {
  it("should apply single-flag correct and wrong scoring with ALL_NEW records", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ score: 5, wrongAnswerCount: 0 }))]);
    reset();

    const ok = await repo.applyFlagCorrectScore("j1", 10, AT);
    expect(ok.outcome).toBe("updated");
    expect(ok.outcome === "updated" && ok.record?.score).toBe(15);
    expect(ok.outcome === "updated" && ok.record?.flagSubmitted).toBe(true);
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "ADD score :pts SET flagSubmitted = :true, lastScoredAt = :now, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
      ReturnValues: "ALL_NEW",
    });

    reset();
    await expectOutcome(repo.applyFlagCorrectScore("j1", 10, AT), "conflict");

    await seed([itemFrom(deployment({ jobId: "wrong", score: 5, wrongAnswerCount: 0 }))]);
    reset();
    const wrong = await repo.applyFlagWrongPenalty("wrong", 2, AT);
    expect(wrong.outcome === "updated" && wrong.record?.score).toBe(3);
    expect(wrong.outcome === "updated" && wrong.record?.wrongAnswerCount).toBe(1);
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
      ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
      ReturnValues: "ALL_NEW",
    });
  });

  it("should apply multi-flag scoring with set ADD and contains guards", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ score: 5, solvedFlagIds: new Set(["first"]) }))]);
    reset();

    const ok = await repo.applyMultiFlagCorrectScore("j1", 7, "second", AT);
    expect(ok.outcome === "updated" && ok.record?.score).toBe(12);
    expect([
      ...(ok.outcome === "updated" ? (ok.record?.solvedFlagIds ?? new Set()) : new Set()),
    ]).toEqual(["first", "second"]);
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "ADD score :pts, solvedFlagIds :flagIdSet SET lastScoredAt = :now, updatedAt = :now",
      ConditionExpression:
        "attribute_not_exists(solvedFlagIds) OR NOT contains(solvedFlagIds, :flagId)",
      ReturnValues: "ALL_NEW",
    });

    reset();
    await expectOutcome(repo.applyMultiFlagCorrectScore("j1", 7, "second", AT), "conflict");

    await seed([itemFrom(deployment({ jobId: "multi-wrong", score: 5, wrongAnswerCount: 0 }))]);
    reset();
    const wrong = await repo.applyMultiFlagWrongPenalty("multi-wrong", 3, "first", AT);
    expect(wrong.outcome === "updated" && wrong.record?.score).toBe(2);
    expect(wrong.outcome === "updated" && wrong.record?.wrongAnswerCount).toBe(1);
    expect(updates(commands)[0].input.UpdateExpression).toBe(
      "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
    );
  });

  it("should apply hint penalty with list_append and updateDisplayTeamName with ALL_NEW", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ score: 20 }))]);
    reset();

    const hint = { hintId: "h1", revealedAt: AT, penaltyApplied: 4 };
    const result = await repo.applyHintPenalty("j1", hint, AT);
    expect(result.outcome === "updated" && result.record?.score).toBe(16);
    expect(result.outcome === "updated" && result.record?.hintsRevealed).toEqual([hint]);
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "SET hintsRevealed = list_append(if_not_exists(hintsRevealed, :empty), :record), updatedAt = :now ADD score :neg",
      ConditionExpression:
        "attribute_not_exists(hintsRevealed) OR NOT contains(hintsRevealed, :recordForContains)",
      ReturnValues: "ALL_NEW",
    });

    reset();
    await expectOutcome(repo.applyHintPenalty("j1", hint, AT), "conflict");

    reset();
    const renamed = await repo.updateDisplayTeamName("j1", "New Name", AT);
    expect(renamed.outcome === "updated" && renamed.record?.displayTeamName).toBe("New Name");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
      ReturnValues: "ALL_NEW",
    });
  });
});

describe("DynamoDbDeploymentsRepository writes — generic scoring", () => {
  it("should build the applyKindScoringResult dynamic expression in source order", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ score: 1 }))]);
    reset();

    await expectOutcome(
      repo.applyKindScoringResult(
        "j1",
        {
          scoreDelta: 5,
          lastResult: "ok",
          endpointsHealthJson: '{"ok":true}',
          attackProbesJson: '{"probes":[]}',
          postureJson: '{"tier":"green"}',
          platform: "posture-3",
          newState: { attackCount: 1 },
        },
        AT,
      ),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "ADD score :pts SET lastScoredAt = :now, updatedAt = :now, lastResult = :lr, endpointsHealth = :health, attackProbes = :attackProbes, posture = :posture, platform = :platform, scoringState = :state",
      ExpressionAttributeValues: {
        ":now": AT,
        ":pts": 5,
        ":lr": "ok",
        ":health": '{"ok":true}',
        ":attackProbes": '{"probes":[]}',
        ":posture": '{"tier":"green"}',
        ":platform": "posture-3",
        ":state": '{"attackCount":1}',
      },
    });
    expect((await repo.getDeployment("j1"))?.score).toBe(6);

    reset();
    await expectOutcome(repo.applyKindScoringResult("j1", { scoreDelta: 0 }, AT), "updated");
    expect(updates(commands)[0].input.UpdateExpression).toBe(
      "SET lastScoredAt = :now, updatedAt = :now",
    );
  });

  it("should pin CAS, latch, state, stuck-delete, and runtime update expressions", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([
      { ...itemFrom(deployment({ jobId: "parent", status: "PENDING" })), runtimeKind: "composite" },
      itemFrom(deployment({ jobId: "gate", status: "COMPLETE" })),
      itemFrom(deployment({ jobId: "state", status: "COMPLETE" })),
      itemFrom(deployment({ jobId: "stuck", status: "DELETING", teamLoginKey: "KEY-STUCK" })),
      itemFrom(deployment({ jobId: "stuck-create", status: "IN_PROGRESS" })),
      itemFrom(deployment({ jobId: "runtime", status: "IN_PROGRESS" })),
    ]);

    reset();
    await expectOutcome(
      repo.casCompositeParentStatus("parent", "PENDING", "IN_PROGRESS", AT),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET #s = :next, updatedAt = :now",
      ConditionExpression: "#s = :prev AND runtimeKind = :composite",
    });

    reset();
    await expectOutcome(repo.latchGateCompleted("gate", AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET gateCompletedAt = :now, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(gateCompletedAt)",
    });
    reset();
    await expectOutcome(repo.latchGateCompleted("gate", AT), "conflict");

    reset();
    await expectOutcome(
      repo.setScoringState("state", '{"firedDisruptions":["d1"]}', AT),
      "updated",
    );
    expect(updates(commands)[0].input.UpdateExpression).toBe(
      "SET scoringState = :state, updatedAt = :now",
    );

    reset();
    await expectOutcome(repo.markStuckDeletingFailed("stuck", "stuck > 30 min", AT), "updated");
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression:
        "SET #status = :failed, updatedAt = :now, #reason = :reason REMOVE GSI2PK, GSI2SK",
      ConditionExpression: "#status = :deleting",
    });
    expect((await repo.getDeployment("stuck"))?.teamLoginKey).toBe("KEY-STUCK");

    reset();
    await expectOutcome(
      repo.markStuckCreatingFailed("stuck-create", "create timed out", AT),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET #status = :failed, updatedAt = :now, #reason = :reason",
      ConditionExpression: "#status IN (:pending, :inProgress)",
    });

    reset();
    await expectOutcome(
      repo.transitionRuntimeStatus("runtime", "tenant-a", "IN_PROGRESS", "COMPLETE", "{}", AT),
      "updated",
    );
    expect(updates(commands)[0].input).toMatchObject({
      UpdateExpression: "SET #s = :next, updatedAt = :now, stackOutputs = :outputs",
      ConditionExpression: "tenantId = :tenant AND #s = :cur",
    });
    reset();
    await expectOutcome(
      repo.transitionRuntimeStatus("runtime", "tenant-a", "IN_PROGRESS", "COMPLETE", undefined, AT),
      "conflict",
    );
  });
});

describe("DynamoDbDeploymentsRepository writes — transactions", () => {
  it("should award a gate bonus atomically with its score event and preserve all-or-nothing", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ jobId: "gate", score: 10 }))]);
    reset();

    await expectOutcome(
      repo.awardGateBonusAtomic(
        { jobId: "gate", problemId: "p1", teamId: "t1", eventId: "ev1", expiresAt: 100 },
        25,
        AT,
      ),
      "updated",
    );
    const tx = transacts(commands)[0].input;
    expect(tx.TransactItems[0].Update).toMatchObject({
      TableName: TABLE,
      Key: { PK: "DEPLOYMENT#gate", SK: "META" },
      UpdateExpression: "ADD score :bonus SET gateBonusAwardedAt = :now, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(gateBonusAwardedAt)",
      ExpressionAttributeValues: { ":bonus": 25, ":now": AT },
    });
    expect(tx.TransactItems[1].Put.Item).toMatchObject({
      PK: "DEPLOYMENT#gate",
      jobId: "gate",
      source: "gate-bonus",
      points: 25,
      occurredAt: AT,
    });
    expect((await repo.getDeployment("gate"))?.score).toBe(35);
    expect(await repo.listScoreEvents("gate", { pageSize: 10 })).toHaveLength(1);

    reset();
    await expectOutcome(
      repo.awardGateBonusAtomic(
        { jobId: "gate", problemId: "p1", teamId: "t1", eventId: "ev1", expiresAt: 100 },
        25,
        AT,
      ),
      "conflict",
    );
    expect((await repo.getDeployment("gate"))?.score).toBe(35);
    expect(await repo.listScoreEvents("gate", { pageSize: 10 })).toHaveLength(1);
  });

  it("should create bulk deployments with replacement deletes atomically", async () => {
    const { repo, seed, reset, commands } = recording();
    await seed([itemFrom(deployment({ jobId: "old", status: "FAILED" }))]);
    reset();

    await expectOutcome(
      repo.createBulkDeployments("tenant-a", [
        {
          record: deployment({ jobId: "bulk-new", eventId: "ev1", teamId: "t1" }),
          replacesJobId: "old",
        },
      ]),
      "updated",
    );
    const tx = transacts(commands)[0].input;
    expect(tx.TransactItems[0].Put).toMatchObject({
      TableName: TABLE,
      ConditionExpression: "attribute_not_exists(PK)",
    });
    expect(tx.TransactItems[0].Put.Item).toMatchObject({
      PK: "DEPLOYMENT#bulk-new",
      GSI1PK: "TENANT#tenant-a",
      GSI2PK: "TEAMKEY#KEY-A",
    });
    expect(tx.TransactItems[1].Delete).toEqual({
      TableName: TABLE,
      Key: { PK: "DEPLOYMENT#old", SK: "META" },
      ConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": "tenant-a" },
    });
    expect(await repo.getDeployment("bulk-new")).toMatchObject({ jobId: "bulk-new" });
    expect(await repo.getDeployment("old")).toBeUndefined();

    await seed([itemFrom(deployment({ jobId: "old-2", tenantId: "tenant-b" }))]);
    reset();
    await expectOutcome(
      repo.createBulkDeployments("tenant-a", [
        { record: deployment({ jobId: "bulk-conflict" }), replacesJobId: "old-2" },
      ]),
      "conflict",
    );
    expect(await repo.getDeployment("bulk-conflict")).toBeUndefined();
    expect(await repo.getDeployment("old-2")).toMatchObject({ tenantId: "tenant-b" });
  });
});
