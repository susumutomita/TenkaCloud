import { describe, expect, it, vi } from "vitest";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/deployments-repository";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository";
import { DynamoDbDeploymentsRepository } from "../../lib/problem-deploy/control-data/dynamodb-deployments-repository";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

/**
 * [Issue #2946] 「一度でも COMPLETE に到達した」marker が撤去後も残ることの検証。
 *
 * これが無いと、利用量画面の per-tenant 集計 (実行中 / 完了 / 失敗) は全て現在値なので、deploy を
 * 撤去すると 3 列そろって 0 になる。結果として「成功する deploy を何度も回している健全な
 * テナント」と「一度も deploy していないテナント」が **どちらも 0 / 0 / 0** で区別できない。
 *
 * 現在値の `status` からは復元できない。`bulk-delete.ts` の `prepareBulkTeardownEntry` は
 * `DELETING` / `DELETED` だけを skip するので `FAILED` な deployment も teardown 経路で
 * `DELETED` になりうる。つまり `DELETED` は「成功後の撤去」と「失敗後の撤去」の両方を含む。
 *
 * #2672 が素通りした穴をここで塞ぐ: parity test は戻り値の一致だけでなく **撤去後に marker が
 * 残るか** を検証する。SQL backend の `mutateExisting` は payload から全列を rewrite するため、
 * 撤去経路で marker が落ちる形の実装をしていたらここで落ちる。
 */

const TENANT = "tenant-1";
const CREATED_AT = "2026-08-08T05:10:11.000Z";
const COMPLETED_AT = "2026-08-08T05:12:00.000Z";
const DELETED_AT = "2026-08-08T05:15:42.000Z";

function baseDeployment(jobId: string): DeploymentRecord {
  return {
    jobId,
    tenantId: TENANT,
    problemId: "hello-world",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "Alpha",
    namePrefix: `tc-alpha-${jobId}`,
    status: "PENDING",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: 4_102_444_800,
  };
}

function freshSqlRepo(): SqlDeploymentsRepository {
  return new SqlDeploymentsRepository(makeSqliteExecutor());
}

describe("SQL backend: the completion marker outlives teardown", () => {
  it("should keep completedAt and the cumulative count after the deployment is torn down", async () => {
    const repo = freshSqlRepo();
    await repo.putDeployment(baseDeployment("job-1"));
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(0);

    await repo.markCreateSucceeded("job-1", "stack-1", "{}", undefined, COMPLETED_AT);
    expect((await repo.getDeployment("job-1"))?.completedAt).toBe(COMPLETED_AT);
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(1);

    // 撤去。現在値の status は DELETED になるが、marker は残らなければならない。
    await repo.markDeleting("job-1", DELETED_AT);
    await repo.markDeleted("job-1", DELETED_AT);

    const afterTeardown = await repo.getDeployment("job-1");
    expect(afterTeardown?.status).toBe("DELETED");
    expect(afterTeardown?.completedAt).toBe(COMPLETED_AT);
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(1);
  });

  it("should not mark a deployment that only ever failed", async () => {
    const repo = freshSqlRepo();
    await repo.putDeployment(baseDeployment("job-2"));
    await repo.markCreateFailed("job-2", "stack rolled back", undefined, DELETED_AT);
    // FAILED も teardown 経路で DELETED になりうる。だからこそ status では区別できない。
    await repo.markDeleting("job-2", DELETED_AT);
    await repo.markDeleted("job-2", DELETED_AT);

    expect((await repo.getDeployment("job-2"))?.status).toBe("DELETED");
    expect((await repo.getDeployment("job-2"))?.completedAt).toBeUndefined();
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(0);
  });

  it("should separate a healthy tenant from an idle one after both are torn down", async () => {
    // この test が issue の核心そのもの。撤去後、現在値では両者が 0/0/0 で同じに見える。
    const repo = freshSqlRepo();
    await repo.putDeployment(baseDeployment("healthy-1"));
    await repo.markCreateSucceeded("healthy-1", "stack-a", "{}", undefined, COMPLETED_AT);
    await repo.markDeleting("healthy-1", DELETED_AT);
    await repo.markDeleted("healthy-1", DELETED_AT);

    expect(await repo.countActiveByTenant(TENANT, ["PENDING", "IN_PROGRESS"])).toBe(0);
    expect(await repo.countActiveByTenant(TENANT, ["FAILED"])).toBe(0);
    expect(await repo.countActiveByTenant(TENANT, ["COMPLETE"])).toBe(0);
    // 現在値は全部 0。累計だけが「このテナントは動いていた」と言える。
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(1);

    const idleRepo = freshSqlRepo();
    expect(await idleRepo.countEverCompletedByTenant(TENANT)).toBe(0);
  });

  it("should not move the marker when the success path runs again", async () => {
    const repo = freshSqlRepo();
    await repo.putDeployment(baseDeployment("job-3"));
    await repo.markCreateSucceeded("job-3", "stack-1", "{}", undefined, COMPLETED_AT);
    await repo.markCreateSucceeded("job-3", "stack-1", "{}", undefined, DELETED_AT);
    expect((await repo.getDeployment("job-3"))?.completedAt).toBe(COMPLETED_AT);
  });

  it("should not count rows written before the marker existed", async () => {
    // 遡及はできない。既存行は marker を持たないので数に入らない — それを 0 件成功と
    // 混同しないのは表示側の責任 (usage.ts が null と 0 を分ける)。
    const repo = freshSqlRepo();
    await repo.putDeployment({ ...baseDeployment("legacy-1"), status: "DELETED" });
    expect(await repo.countEverCompletedByTenant(TENANT)).toBe(0);
  });
});

describe("DynamoDB backend: the same marker contract", () => {
  function makeRepo(sent: Record<string, unknown>[]) {
    const ddb = {
      send: vi.fn(async (command: { input?: Record<string, unknown> }) => {
        sent.push(command.input ?? {});
        return { Count: 0 };
      }),
    };
    return new DynamoDbDeploymentsRepository(ddb as never, "Deployments");
  }

  it("should write completedAt exactly once with if_not_exists", async () => {
    const sent: Record<string, unknown>[] = [];
    await makeRepo(sent).markCreateSucceeded("job-1", "stack-1", "{}", undefined, COMPLETED_AT);
    const command = sent[0];
    expect(command).toBeDefined();
    // `if_not_exists` でないと、この経路の再入で最初の到達時刻が上書きされる。
    expect(String(command?.UpdateExpression)).toContain(
      "completedAt = if_not_exists(completedAt, :completedAt)",
    );
    const values = command?.ExpressionAttributeValues as Record<string, unknown> | undefined;
    expect(values?.[":completedAt"]).toBe(COMPLETED_AT);
  });

  it("should count by marker presence rather than by current status", async () => {
    const sent: Record<string, unknown>[] = [];
    await makeRepo(sent).countEverCompletedByTenant(TENANT);
    expect(sent[0]?.FilterExpression).toBe("attribute_exists(completedAt)");
    expect(sent[0]?.Select).toBe("COUNT");
    // status を条件にしないことが要点。撤去して DELETED になった行も数え続ける。
    expect(String(sent[0]?.FilterExpression)).not.toContain("status");
  });

  it("should not touch completedAt on the failure path", async () => {
    const sent: Record<string, unknown>[] = [];
    await makeRepo(sent).markCreateFailed("job-1", "rolled back", undefined, DELETED_AT);
    expect(String(sent[0]?.UpdateExpression)).not.toContain("completedAt");
  });
});
