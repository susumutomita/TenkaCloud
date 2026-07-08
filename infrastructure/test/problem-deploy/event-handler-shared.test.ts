import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { queryDeploymentsByEvent } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * [Issue #2441 / Phase B PR-6] `queryDeploymentsByEvent` used to have a raw-`QueryCommand`
 * fast path (`projectionExpression` param, historically for Issue #670's `#s` alias fix) that
 * bypassed the `DeploymentsRepository` seam entirely. That path hard-coded
 * `TableName: shared.deploymentsTableName`, which is `""` once pure SQL backends
 * (turso|sql) stop synthesizing the Deployments table — a residual gap the 62-site
 * migration (Phase B1-B3) missed since `bulk-deploy/orchestrator.ts` was its only caller.
 * The parameter is gone; every caller now goes through `resolveDeploymentsRepository` +
 * `listByTenantAndEvent` (default backend keeps the byte-identical full-page-drain
 * GSI1 Query this file used to construct by hand; that Query's own pagination /
 * `#1797` full-page-drain behavior is pinned in
 * `test/problem-deploy/control-data/deployments-repository.test.ts` +
 * `deployments-repository-parity.test.ts`, not duplicated here).
 */
describe("queryDeploymentsByEvent (#2441 Phase B PR-6: repository seam, no raw bypass)", () => {
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

  it("should delegate to the repository seam (GSI1 Query on the default dynamodb backend)", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ PK: "DEPLOYMENT#a", SK: "META", jobId: "a", eventId: "evt-1" }],
      })
      .mockResolvedValue({ Items: [] });
    const result = await queryDeploymentsByEvent(buildShared(send), "tenant-acme", "evt-1");
    expect(send).toHaveBeenCalled();
    const cmd = send.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.TableName).toBe("TestDeployments");
    expect(cmd.input.IndexName).toBe("GSI1");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(result.map((r) => r.jobId)).toEqual(["a"]);
  });

  it("should return an empty array when no rows match (no throw on an empty page)", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const result = await queryDeploymentsByEvent(buildShared(send), "tenant-acme", "evt-1");
    expect(result).toEqual([]);
  });
});
