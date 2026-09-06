import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import type { CoordinationScoreUpdate } from "../../../lib/problem-deploy/control-data/domain/coordination-score";
import type { DeploymentRecord } from "../../../lib/problem-deploy/control-data/domain/deployments";
import { buildScoreEventRecord } from "../../../lib/problem-deploy/handlers/shared/score-event";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

const OCCURRED = "2026-09-06T00:00:00.000Z";
const EARLIER = "2026-09-05T23:59:00.000Z";
const SCORED = "2026-09-06T00:01:00.000Z";
const STATUS_CHANGED = "2026-09-06T00:02:00.000Z";
const DELIVERED = "2026-09-06T00:03:00.000Z";
const SCOPE = { tenantId: "tenant-a", eventId: "event-a", problemId: "battle-a", runId: "default" };
const DEPLOYMENT: DeploymentRecord = {
  ...SCOPE,
  jobId: "job-a",
  teamId: "team-a",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  teamName: "alpha",
  namePrefix: "tc-alpha-battle",
  status: "COMPLETE",
  createdAt: EARLIER,
  updatedAt: EARLIER,
  score: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DELIVERED);
});
afterEach(() => vi.useRealTimers());

async function setup(backend: string, lastScoredAt?: string) {
  let beforePublish: (() => Promise<void>) | undefined;
  const race = async () => {
    const action = beforePublish;
    beforePublish = undefined;
    await action?.();
  };
  const ddb = makeFakeDdb();
  const send = ddb.send.bind(ddb);
  ddb.send = (async (cmd: unknown) => {
    if (cmd instanceof TransactWriteCommand && cmd.input.TransactItems?.some((item) => item.Update))
      await race();
    return send(cmd as never);
  }) as typeof ddb.send;
  const baseSql = makeSqliteExecutor();
  const sql = {
    ...baseSql,
    batch: async (statements: Parameters<typeof baseSql.batch>[0]) => {
      if (statements[0]?.sql.startsWith("UPDATE deployments SET score")) await race();
      return baseSql.batch(statements);
    },
  };
  const repository =
    backend === "DynamoDB"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  await repository.putDeployment({ ...DEPLOYMENT, ...(lastScoredAt ? { lastScoredAt } : {}) });
  await repository.writeCoordinationState(
    SCOPE,
    {
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 1,
      state: { score: 30 },
      pendingScores: {
        occurredAt: OCCURRED,
        teams: { "team-a": { before: 0, score: 30, reason: "cipher" } },
      },
    },
    0,
    OCCURRED,
    0,
  );
  const update = (ordinaryScore = 0): CoordinationScoreUpdate => ({
    jobId: DEPLOYMENT.jobId,
    teamId: "team-a",
    expectedScore: ordinaryScore,
    expectedStatus: "COMPLETE",
    score: ordinaryScore + 30,
    coordinationSubtotal: 30,
    occurredAt: OCCURRED,
    events: [
      { ...buildScoreEventRecord(DEPLOYMENT, "coordination", 30, OCCURRED), reason: "cipher" },
    ],
  });
  return {
    repository,
    sql,
    update,
    onPublish: (action: () => Promise<void>) => {
      beforePublish = action;
    },
  };
}

describe.each(["DynamoDB", "SQL"])("coordination delivery timestamps: %s", (backend) => {
  it("keeps a newer ordinary scoring time and records delivery after later status progress", async () => {
    const { repository, sql, update } = await setup(backend);
    await repository.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 5 }, SCORED);
    await repository.markCreateSucceeded(
      DEPLOYMENT.jobId,
      "new-stack",
      "{}",
      undefined,
      STATUS_CHANGED,
    );

    expect(await repository.publishCoordinationScore(SCOPE, 1, update(5))).toEqual({
      outcome: "updated",
    });
    expect(await repository.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 35,
      stackId: "new-stack",
      status: "COMPLETE",
      lastScoredAt: SCORED,
      updatedAt: DELIVERED,
    });
    expect(await repository.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toMatchObject([
      { occurredAt: OCCURRED, points: 30 },
    ]);
    if (backend === "SQL")
      expect(
        await sql.get("SELECT updated_at FROM deployments WHERE job_id = ?", [DEPLOYMENT.jobId]),
      ).toEqual({ updated_at: DELIVERED });
  });

  it.each([
    undefined,
    EARLIER,
  ])("advances a missing or older scoring timestamp (%s) to the event time", async (previous) => {
    const { repository, update } = await setup(backend, previous);
    expect(await repository.publishCoordinationScore(SCOPE, 1, update())).toEqual({
      outcome: "updated",
    });
    expect(await repository.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      lastScoredAt: OCCURRED,
      updatedAt: DELIVERED,
    });
  });

  it.each([
    undefined,
    EARLIER,
  ])("keeps a concurrent zero-point scorer's timestamp when the prior value was %s", async (previous) => {
    const { repository, update, onPublish } = await setup(backend, previous);
    // Score and status stay identical: only lastScoredAt/updatedAt advance
    // after the publisher has prepared its transaction.
    onPublish(async () => {
      await repository.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 0 }, SCORED);
    });

    const result = await repository.publishCoordinationScore(SCOPE, 1, update());
    expect((await repository.getDeployment(DEPLOYMENT.jobId))?.lastScoredAt).toBe(SCORED);
    if (result.outcome === "conflict") {
      expect(await repository.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toEqual([]);
      expect(await repository.publishCoordinationScore(SCOPE, 1, update())).toEqual({
        outcome: "updated",
      });
    } else expect(result.outcome).toBe("updated");
    expect(await repository.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 30,
      lastScoredAt: SCORED,
      updatedAt: DELIVERED,
    });
    expect(await repository.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toMatchObject([
      { occurredAt: OCCURRED, points: 30 },
    ]);
  });
});
