import { describe, expect, it } from "vitest";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository";
import { hashLoginKey } from "../../lib/problem-deploy/control-data/sql-teams-repository";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/types";
import { applyDeployStatusWrite } from "../../lib/problem-deploy/handlers/deploy-status-writer-handler";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

const AT = "2026-07-08T12:00:00.000Z";

function deployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    jobId: "job-1",
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

describe("deploy-status-writer-handler", () => {
  it("should route MarkInProgress / MarkSucceeded / MarkFailed into the repository seam", async () => {
    const repository = new SqlDeploymentsRepository(makeSqliteExecutor());
    await repository.putDeployment(deployment());

    await expect(
      applyDeployStatusWrite(
        { transition: "markInProgress", jobId: "job-1", updatedAt: AT },
        { repository },
      ),
    ).resolves.toMatchObject({ outcome: "updated" });
    expect(await repository.getDeployment("job-1")).toMatchObject({
      status: "IN_PROGRESS",
      updatedAt: AT,
    });

    await expect(
      applyDeployStatusWrite(
        {
          transition: "markSucceeded",
          jobId: "job-1",
          updatedAt: AT,
          stackId: "stack-1",
          stackOutputs: "[]",
          buildId: "build-1",
        },
        { repository },
      ),
    ).resolves.toMatchObject({ outcome: "updated" });
    expect(await repository.getDeployment("job-1")).toMatchObject({
      status: "COMPLETE",
      stackId: "stack-1",
      stackOutputs: "[]",
      buildId: "build-1",
    });

    await expect(
      applyDeployStatusWrite(
        {
          transition: "markFailed",
          jobId: "job-1",
          updatedAt: AT,
          failureReason: "rollback",
        },
        { repository },
      ),
    ).resolves.toMatchObject({ outcome: "updated" });
    expect(await repository.getDeployment("job-1")).toMatchObject({
      status: "FAILED",
      failureReason: "rollback",
      buildId: "build-1",
    });
  });

  it("should be safe for at-least-once replay of the same SFN task input", async () => {
    const repository = new SqlDeploymentsRepository(makeSqliteExecutor());
    await repository.putDeployment(deployment({ status: "IN_PROGRESS" }));
    const event = {
      transition: "markSucceeded" as const,
      jobId: "job-1",
      updatedAt: AT,
      stackId: "stack-1",
      stackOutputs: '[{"OutputKey":"Url","OutputValue":"https://example.test"}]',
    };

    await applyDeployStatusWrite(event, { repository });
    await applyDeployStatusWrite(event, { repository });

    expect(await repository.getDeployment("job-1")).toMatchObject({
      status: "COMPLETE",
      updatedAt: AT,
      stackId: "stack-1",
      stackOutputs: '[{"OutputKey":"Url","OutputValue":"https://example.test"}]',
    });
  });

  it("should preserve the SQL login-key hash while updating status payloads", async () => {
    const sql = makeSqliteExecutor();
    const repository = new SqlDeploymentsRepository(sql);
    await repository.putDeployment(deployment({ teamLoginKey: "LOGIN-KEY" }));

    await applyDeployStatusWrite(
      { transition: "markInProgress", jobId: "job-1", updatedAt: AT },
      { repository },
    );

    const row = await sql.get("SELECT login_key_hash FROM deployments WHERE job_id = ?", ["job-1"]);
    expect(row?.login_key_hash).toBe(hashLoginKey("LOGIN-KEY"));
  });

  it("should reject malformed events before writing", async () => {
    const repository = new SqlDeploymentsRepository(makeSqliteExecutor());
    await expect(
      applyDeployStatusWrite(
        { transition: "markSucceeded", jobId: "job-1", updatedAt: AT, stackId: "stack-1" },
        { repository },
      ),
    ).rejects.toThrow(/stackOutputs/);
  });
});
