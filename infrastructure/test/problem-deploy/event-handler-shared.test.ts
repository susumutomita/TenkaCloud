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

  it("projection に `#s` が含まれるなら ExpressionAttributeNames で alias を提供すべき", async () => {
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
});
