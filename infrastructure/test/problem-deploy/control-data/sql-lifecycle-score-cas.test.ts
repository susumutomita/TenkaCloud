import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../../../lib/problem-deploy/control-data/domain/deployments";
import { SqlDeploymentsRepository } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/sql-port";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

const AT = "2026-09-06T00:00:00.000Z";
const DEPLOYMENT: DeploymentRecord = {
  jobId: "job-lifecycle",
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

const transitions = [
  [
    "COMPLETE",
    (repo: SqlDeploymentsRepository) =>
      repo.markCreateSucceeded(DEPLOYMENT.jobId, "stack-a", "{}", undefined, AT),
  ],
  [
    "IN_PROGRESS",
    (repo: SqlDeploymentsRepository) => repo.markCreateInProgress(DEPLOYMENT.jobId, AT),
  ],
  [
    "FAILED",
    (repo: SqlDeploymentsRepository) =>
      repo.markCreateFailed(DEPLOYMENT.jobId, "failed", undefined, AT),
  ],
  ["DELETED", (repo: SqlDeploymentsRepository) => repo.markDeleted(DEPLOYMENT.jobId, AT)],
] as const;

describe("SQL lifecycle writes preserve concurrent scores (#3194)", () => {
  it.each(
    transitions,
  )("should preserve the winning score while writing status %s", async (status, transition) => {
    const sql = makeSqliteExecutor();
    const winner = new SqlDeploymentsRepository(sql);
    await winner.putDeployment(DEPLOYMENT);
    const racing = new SqlDeploymentsRepository(
      raceAfterRead(sql, async (reads) => {
        if (reads === 1)
          await winner.applyKindScoringResult(DEPLOYMENT.jobId, { scoreDelta: 30 }, AT);
      }),
    );

    expect(await transition(racing)).toEqual({ outcome: "updated" });
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({ score: 30, status });
    expect(
      await sql.get("SELECT score, status FROM deployments WHERE job_id = ?", [DEPLOYMENT.jobId]),
    ).toEqual({ score: 30, status });
    expect(await winner.listByTeamLoginKey("participant-key")).toHaveLength(
      status === "DELETED" ? 0 : 1,
    );
  });

  it.each(
    transitions,
  )("should report conflict after three losing %s attempts without clearing the credential", async (_status, transition) => {
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

    expect(await transition(racing)).toEqual({ outcome: "conflict" });
    expect(attempts).toBe(3);
    expect(await winner.getDeployment(DEPLOYMENT.jobId)).toMatchObject({
      score: 3,
      status: "COMPLETE",
    });
    expect(await winner.listByTeamLoginKey("participant-key")).toHaveLength(1);
  });

  it.each(
    transitions,
  )("should retain not_found for an absent row during %s", async (_status, transition) => {
    const repository = new SqlDeploymentsRepository(makeSqliteExecutor());
    expect(await transition(repository)).toEqual({ outcome: "not_found" });
    expect(await repository.getDeployment(DEPLOYMENT.jobId)).toBeUndefined();
  });
});
