import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../../../lib/problem-deploy/control-data/domain/deployments";
import { SqlDeploymentsRepository } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/sql-port";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

const AT = "2026-09-06T00:00:00.000Z";
const DEPLOYMENT: DeploymentRecord = {
  jobId: "job-bonus",
  tenantId: "tenant-a",
  eventId: "event-a",
  problemId: "battle-a",
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

/** Commit the competing operation after SELECT, before the bonus transaction. */
function raceAfterRead(
  sql: SqlExecutor,
  action: (readNumber: number) => Promise<void>,
): SqlExecutor {
  let reads = 0;
  return {
    ...sql,
    get: async (query, params) => {
      const observed = await sql.get(query, params);
      if (query === "SELECT * FROM deployments WHERE job_id = ?") await action(++reads);
      return observed;
    },
  };
}

describe("SQL gate bonus score and history CAS (#3194)", () => {
  it("should retry on the committed score and keep exactly one bonus history event", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1)
          await winner.applyKindScoringResult(
            DEPLOYMENT.jobId,
            { scoreDelta: 30, newState: { round: 2 } },
            AT,
          );
      }),
    );

    expect(await racing.awardGateBonusAtomic(DEPLOYMENT, 5, AT)).toEqual({ outcome: "updated" });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 35,
      scoringState: JSON.stringify({ round: 2 }),
      gateBonusAwardedAt: AT,
    });
    expect(
      await sql.get("SELECT score FROM deployments WHERE job_id = ?", [DEPLOYMENT.jobId]),
    ).toEqual({ score: 35 });
    expect(await winner.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toMatchObject([
      { source: "gate-bonus", points: 5, occurredAt: AT },
    ]);
    expect(await winner.listByTeamLoginKey("participant-key")).toHaveLength(1);
  });

  it("should reject a duplicate award after another request wins, without a second history event", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1)
          expect(await winner.awardGateBonusAtomic(DEPLOYMENT, 5, AT)).toEqual({
            outcome: "updated",
          });
      }),
    );

    expect(await racing.awardGateBonusAtomic(DEPLOYMENT, 5, AT)).toEqual({ outcome: "conflict" });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({ score: 5 });
    expect(await winner.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toHaveLength(1);
  });

  it("should preserve unrelated fields changed while the bonus was being computed", async () => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1) await winner.updateDisplayTeamName(DEPLOYMENT.jobId, "new name", AT);
      }),
    );

    expect(await racing.awardGateBonusAtomic(DEPLOYMENT, 5, AT)).toEqual({ outcome: "updated" });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 5,
      displayTeamName: "new name",
    });
    expect(await winner.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toHaveLength(1);
  });

  it("should leave no bonus history or marker after three lost transactions", async () => {
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

    expect(await racing.awardGateBonusAtomic(DEPLOYMENT, 5, AT)).toEqual({ outcome: "conflict" });
    expect(attempts).toBe(3);
    const saved = await winner.getDeployment(DEPLOYMENT.jobId);
    expect(saved?.score).toBe(3);
    expect(saved?.gateBonusAwardedAt).toBeUndefined();
    expect(await winner.listScoreEvents(DEPLOYMENT.jobId, { pageSize: 10 })).toEqual([]);
  });
});
