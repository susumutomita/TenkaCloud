import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { queryDeploymentsByEvent } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * Issue #670: bulk-deploy が `jobId, teamId, problemId, #s` という projection で
 * queryDeploymentsByEvent を呼び、 DDB が ExpressionAttributeNames に `#s` が
 * 定義されていないため `Invalid ProjectionExpression` で 500 に潰れていた。
 * helper 側で `#s` alias を自動定義することを pin。
 */
describe("queryDeploymentsByEvent (Issue #670)", () => {
  const buildShared = (sendSpy: ReturnType<typeof vi.fn>) => ({
    ddb: { send: sendSpy } as never,
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    eventBridge: { send: vi.fn() } as never,
    env: "development",
    defaultTenantId: "tenant-acme",
    problemsCatalog: {},
  });

  it("should provide an ExpressionAttributeNames alias when projection contains `#s`", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await queryDeploymentsByEvent(
      buildShared(send),
      "tenant-acme",
      "evt-1",
      "jobId, teamId, problemId, #s",
    );
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ProjectionExpression).toBe("jobId, teamId, problemId, #s");
    expect(cmd.input.ExpressionAttributeNames).toEqual({ "#s": "status" });
  });

  it("projection に `#s` が無いなら ExpressionAttributeNames を提供しない (= 既存挙動互換)", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await queryDeploymentsByEvent(
      buildShared(send),
      "tenant-acme",
      "evt-1",
      "jobId, teamId, problemId",
    );
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ProjectionExpression).toBe("jobId, teamId, problemId");
    expect(cmd.input.ExpressionAttributeNames).toBeUndefined();
  });

  it("projection 自体未指定なら ProjectionExpression を付けない", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await queryDeploymentsByEvent(buildShared(send), "tenant-acme", "evt-1");
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ProjectionExpression).toBeUndefined();
    expect(cmd.input.ExpressionAttributeNames).toBeUndefined();
  });

  it("#1797: should drain every page (DynamoDB 1MB limit) so no deployment is missed", async () => {
    // GSI1PK=TENANT#<id> パーティションが 1MB を超えると Query は LastEvaluatedKey を返して
    // ページ分割する。旧コードは 1 ページ目しか読まず、後続ページの deployment を取りこぼした
    // → teardown で対象 stack が enqueue されず orphan 化 / end-event / schedule 伝播も漏れる。
    // FilterExpression(eventId) は各ページ内で適用されるので、目的 event の行が後続ページに
    // 居ると完全に missed。全ページを drain する。
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }], LastEvaluatedKey: { PK: "p2" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "c" }] });

    const result = await queryDeploymentsByEvent(buildShared(send), "tenant-acme", "evt-1");

    expect(send).toHaveBeenCalledTimes(3);
    expect(result.map((r) => r.jobId)).toEqual(["a", "b", "c"]);
    // 1 ページ目は ExclusiveStartKey 無し、2 ページ目以降は前ページの LastEvaluatedKey を渡す。
    expect((send.mock.calls[0]?.[0] as QueryCommand).input.ExclusiveStartKey).toBeUndefined();
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ PK: "p1" });
    expect((send.mock.calls[2]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ PK: "p2" });
  });
});
