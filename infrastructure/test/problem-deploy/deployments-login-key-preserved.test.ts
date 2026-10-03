import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/deployments-repository";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

/**
 * [Issue #2672] Regression: on a pure SQL (turso) backend a read-modify-write that
 * rebuilds the row from `payload` (credential-stripped by #2290) must NOT wipe
 * `deployments.login_key_hash`. Before the fix the first scoring tick / gate bonus /
 * display-name change nulled the column, so `listByTeamLoginKey` returned 0 rows and
 * the participant could no longer log in (401). `markDeleted` still clears the
 * credential on purpose — a deleted deployment must stop resolving by login key.
 *
 * Exercises all three write paths that previously carried the bug: the two
 * `mutateExisting` branches (non-post-image via `applyKindScoringResult`, post-image
 * via `updateDisplayTeamName`) and the direct batch write in `awardGateBonusAtomic`.
 */
const LOGIN_KEY = "team-key-abc";
const AT = "2026-07-16T00:00:00.000Z";

function baseDeployment(): DeploymentRecord {
  return {
    jobId: "job-1",
    tenantId: "local",
    eventId: "event-1",
    teamId: "team-1",
    problemId: "hello-world",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "Alpha",
    namePrefix: "tc-alpha-hello-world",
    teamLoginKey: LOGIN_KEY,
    status: "COMPLETE",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: 4_102_444_800,
  };
}

function freshRepo(): SqlDeploymentsRepository {
  return new SqlDeploymentsRepository(makeSqliteExecutor());
}

async function loggedInJobIds(repo: SqlDeploymentsRepository): Promise<readonly string[]> {
  return (await repo.listByTeamLoginKey(LOGIN_KEY)).map((record) => record.jobId);
}

describe("SQL deployments credential preservation (Issue #2672)", () => {
  it("should still resolve the login key after a scoring tick (applyKindScoringResult)", async () => {
    const repo = freshRepo();
    await repo.putDeployment(baseDeployment());
    expect(await loggedInJobIds(repo)).toEqual(["job-1"]);
    await repo.applyKindScoringResult("job-1", { scoreDelta: 10, lastResult: "ok" }, AT);
    expect(await loggedInJobIds(repo)).toEqual(["job-1"]);
  });

  it("should still resolve the login key after a display-name change (updateDisplayTeamName)", async () => {
    const repo = freshRepo();
    await repo.putDeployment(baseDeployment());
    await repo.updateDisplayTeamName("job-1", "Renamed", AT);
    expect(await loggedInJobIds(repo)).toEqual(["job-1"]);
  });

  it("should still resolve the login key after a gate bonus award (awardGateBonusAtomic)", async () => {
    const repo = freshRepo();
    await repo.putDeployment(baseDeployment());
    await repo.awardGateBonusAtomic(
      {
        jobId: "job-1",
        problemId: "hello-world",
        teamId: "team-1",
        eventId: "event-1",
        expiresAt: 4_102_444_800,
      },
      50,
      AT,
    );
    expect(await loggedInJobIds(repo)).toEqual(["job-1"]);
  });

  it("should still clear the login key on markDeleted (intentional)", async () => {
    const repo = freshRepo();
    await repo.putDeployment(baseDeployment());
    await repo.markDeleted("job-1", AT);
    expect(await loggedInJobIds(repo)).toEqual([]);
  });
});
