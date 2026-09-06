import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../../../lib/problem-deploy/control-data/domain/deployments";
import { SqlDeploymentsRepository } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/sql-port";
import { buildScoreEventRecord } from "../../../lib/problem-deploy/handlers/shared/score-event";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

const AT = "2026-09-06T00:00:00.000Z";
const SCOPE = {
  tenantId: "tenant-a",
  eventId: "event-a",
  problemId: "battle-a",
  runId: "default",
};
const DEPLOYMENT: DeploymentRecord = {
  ...SCOPE,
  jobId: "job-a",
  teamId: "team-a",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  teamName: "alpha",
  namePrefix: "tc-alpha-battle",
  teamLoginKey: "participant-key",
  status: "COMPLETE",
  createdAt: AT,
  updatedAt: AT,
  expiresAt: 4_102_444_800,
  score: 0,
};

/** Interleave a real SQLite write between a mutation's SELECT and UPDATE. */
function raceAfterRead(
  sql: SqlExecutor,
  action: (readNumber: number) => Promise<void>,
): SqlExecutor {
  let reads = 0;
  return {
    ...sql,
    get: async (query, params) => {
      const observed = await sql.get(query, params);
      if (query === "SELECT * FROM deployments WHERE job_id = ?") {
        reads += 1;
        await action(reads);
      }
      return observed;
    },
  };
}

async function saveCoordinationDelivery(repository: SqlDeploymentsRepository): Promise<void> {
  await repository.writeCoordinationState(
    SCOPE,
    {
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 1,
      state: { scores: { "team-a": 30 } },
      pendingScores: {
        occurredAt: AT,
        teams: { "team-a": { before: 0, score: 30, reason: "cipher" } },
      },
    },
    0,
    AT,
    0,
  );
}

async function publishCoordinationDelivery(repository: SqlDeploymentsRepository): Promise<void> {
  expect(
    await repository.publishCoordinationScore(SCOPE, 1, {
      jobId: DEPLOYMENT.jobId,
      teamId: "team-a",
      expectedScore: 0,
      expectedStatus: "COMPLETE",
      score: 30,
      coordinationSubtotal: 30,
      occurredAt: AT,
      events: [{ ...buildScoreEventRecord(DEPLOYMENT, "coordination", 30, AT), reason: "cipher" }],
    }),
  ).toEqual({ outcome: "updated" });
}

describe("SQL deployment payload CAS (#3194)", () => {
  it.each([
    "hint",
    "kind",
  ] as const)("should preserve coordination score, delivery identity and history across a racing %s update", async (kind) => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    await saveCoordinationDelivery(winner);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1) await publishCoordinationDelivery(winner);
      }),
    );

    const outcome =
      kind === "hint"
        ? await racing.applyHintPenalty(DEPLOYMENT.jobId, { hintIndex: 0, penaltyApplied: 2 }, AT)
        : await racing.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 5 }, AT);

    expect(outcome.outcome).toBe("updated");
    const expectedScore = kind === "hint" ? 28 : 35;
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: expectedScore,
      coordinationSubtotal: 30,
      coordinationScoreRunId: "default",
      coordinationScoreVersion: 1,
    });
    if (kind === "hint") {
      expect(outcome).toMatchObject({ record: { score: 28, coordinationSubtotal: 30 } });
    }
    expect(
      await sql.get("SELECT score FROM deployments WHERE job_id = ?", [DEPLOYMENT.jobId]),
    ).toEqual({ score: expectedScore });
    expect(await winner.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toMatchObject([
      { source: "coordination", points: 30, reason: "cipher" },
    ]);
    expect(await winner.listByTeamLoginKey("participant-key")).toHaveLength(1);
  });

  it("should re-evaluate the flag predicate after another request accepts the same flag", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1) await winner.applyFlagCorrectScore(DEPLOYMENT.jobId, 10, AT);
      }),
    );

    expect(await racing.applyFlagCorrectScore(DEPLOYMENT.jobId, 10, AT)).toEqual({
      outcome: "conflict",
    });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 10,
      flagSubmitted: true,
    });
  });

  it("should re-evaluate tenant and status before retrying a lifecycle mutation", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment({ ...DEPLOYMENT, status: "PENDING" });
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1)
          await winner.markDeleting(DEPLOYMENT.jobId, SCOPE.tenantId, AT, DEPLOYMENT.expiresAt);
      }),
    );

    expect(
      await racing.markFailedIfPending(
        DEPLOYMENT.jobId,
        SCOPE.tenantId,
        "stale failure",
        AT,
        DEPLOYMENT.expiresAt,
      ),
    ).toEqual({ outcome: "conflict" });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      status: "DELETING",
      teardownRequestedAt: AT,
    });
  });

  it("should stop after three lost CAS attempts without applying the stale delta", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    let attempts = 0;
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async () => {
        attempts += 1;
        await winner.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 1 }, AT);
      }),
    );

    expect(await racing.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 100 }, AT)).toEqual({
      outcome: "conflict",
    });
    expect(attempts).toBe(3);
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({ score: 3 });
  });

  it("should retain not_found when the row is deleted between attempts", async () => {
    const sql = makeSqliteExecutor();
    const repository = new SqlDeploymentsRepository(sql);
    await repository.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1)
          await sql.run("DELETE FROM deployments WHERE job_id = ?", [DEPLOYMENT.jobId]);
      }),
    );

    expect(
      await racing.applySchedulePatch(DEPLOYMENT.jobId, SCOPE.tenantId, { endsAt: AT }, AT),
    ).toEqual({ outcome: "not_found" });
  });
});
