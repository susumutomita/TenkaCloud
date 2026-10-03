import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository";
import { SqlTeamsRepository } from "../../lib/problem-deploy/control-data/teams-repository";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { buildBulkDeployPlan } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/plan-builder";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

/**
 * The two fields `buildBulkDeployPlan` reads off the shared resources. Bound
 * before the assertion rather than asserted in place: the real surface is far
 * wider than a plan needs, and `consistent-type-assertions` wants a declaration
 * it can annotate.
 */
function sharedFor(problemsCatalog: Record<string, string>): EventSharedResources {
  const partial = { problemsCatalog, eventBusName: "test-bus" };
  return partial as unknown as EventSharedResources;
}

describe("bulkDeployEvent — happy path & chunking", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should expand teams × problems fully, Put deployment rows, and publish DeployCreateRequested", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // GetCommand
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) }); // QueryCommand teams
    // #555: 3 件目は既存 deployments の QueryCommand (空)、その後 TransactWrite + Update
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({}); // PutEvents chunks (1 chunk for 6 entries)

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 6, skipped: 0 },
    });

    // 1 件目: GetCommand (Event)
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    // 2 件目: QueryCommand (Teams)
    expect(ddbSend.mock.calls[1]?.[0]).toBeInstanceOf(QueryCommand);
    // 3 件目: QueryCommand (#555 既存 deployments lookup、idempotent skip 用)
    expect(ddbSend.mock.calls[2]?.[0]).toBeInstanceOf(QueryCommand);
    // TransactWriteCommand (6 items / 1 chunk)
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    expect(transactCmd).toBeInstanceOf(TransactWriteCommand);
    expect(transactCmd?.input.TransactItems).toHaveLength(6);

    // 各 item に eventId / teamId / teamLoginKey が入る
    const firstItem = transactCmd?.input.TransactItems?.[0]?.Put?.Item;
    expect(firstItem?.eventId).toBe("EV1");
    expect(firstItem?.teamId).toBe("T1");
    expect(firstItem?.teamLoginKey).toBe("key-1");
    expect(firstItem?.status).toBe("PENDING");

    // PutEvents は 1 call (6 entries)
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd).toBeInstanceOf(PutEventsCommand);
    expect(putCmd.input.Entries).toHaveLength(6);
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployCreateRequested");
  });

  it("should count problemIds absent from the catalog as skipped", async () => {
    const { shared, ddbSend, eventsSend } = buildShared({
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 2 teams × 2 problems = 4 のうち hello-world-battle (catalog 不在) 2 件 skip
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 2, skipped: 2 } });
  });

  it("should chunk TransactWrite at the 25-items cap", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(15) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    // 15 teams × 2 problems = 30 行 → 25 + 5 で 2 chunk
    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    expect(transactCmds).toHaveLength(2);
    expect(transactCmds[0]?.input.TransactItems).toHaveLength(25);
    expect(transactCmds[1]?.input.TransactItems).toHaveLength(5);
  });

  it("should chunk PutEvents at the 10-entries cap", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(15) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    // 15 teams × 2 problems = 30 entries → 10 + 10 + 10 で 3 chunk
    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const putCmds = eventsSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    expect(putCmds).toHaveLength(3);
    expect(putCmds[0]?.input.Entries).toHaveLength(10);
    expect(putCmds[2]?.input.Entries).toHaveLength(10);
  });

  /**
   * [Issue #3173] A team's own region wins over the problem's.
   *
   * Region used to be decided once per problem and applied to every team, so a
   * whole event landed in one region and met that region's service limits
   * before it met anything else. The deployment row has always stored a region
   * per deployment; only the plan had it fixed.
   */
  it("should deploy a team into its own region, and fall back to the problem's", async () => {
    const sql = makeSqliteExecutor();
    const teams = new SqlTeamsRepository(sql);
    const base = {
      eventId: "EV1",
      tenantId: "tenant-acme",
      awsAccountId: "111111111111",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      expiresAt: 4_102_444_800,
    };
    await teams.putTeam({
      ...base,
      teamId: "T1",
      internalSlug: "team-1",
      teamLoginKey: "K1",
      region: "us-east-1",
    });
    await teams.putTeam({ ...base, teamId: "T2", internalSlug: "team-2", teamLoginKey: "K2" });

    const plan = buildBulkDeployPlan({
      shared: sharedFor({ p1: "problems/challenges/p1" }),
      tenantId: "tenant-acme",
      eventId: "EV1",
      nowMs: NOW_MS,
      event: {},
      selected: {
        teams: await teams.listTeamsForDeployment("EV1"),
        problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
      },
      existing: {
        failedByKey: new Map(),
        forceRedeployByKey: new Map(),
        existingKey: new Set(),
      },
      verified: new Map([
        [
          "111111111111",
          {
            awsAccountId: "111111111111",
            competitorRoleName: "DeployRole",
            region: "ap-northeast-1",
            externalIdParameterName: "/test/external-id",
            competitorRoleArn: "arn:aws:iam::111111111111:role/DeployRole",
          },
        ],
      ]),
      nonAwsCredentials: new Set(),
      retryFailedOnly: false,
      forceRedeploy: false,
    });

    const byTeam = new Map(plan.entries.map((e) => [e.item.teamId, e.item.region]));
    expect(byTeam.get("T1")).toBe("us-east-1");
    expect(byTeam.get("T2")).toBe("ap-northeast-1");
    // The event the deploy state machine receives has to agree with the row
    // that was written, or the stack lands somewhere the row does not name.
    const detailRegion = new Map(
      plan.entries.map((e) => [
        e.item.teamId,
        (
          JSON.parse(String(e.kind === "eventbridge" ? e.entry.Detail : "{}")) as {
            region?: string;
          }
        ).region,
      ]),
    );
    expect(detailRegion.get("T1")).toBe("us-east-1");
    expect(detailRegion.get("T2")).toBe("ap-northeast-1");
  });

  it("should keep the create-response key usable through a pure-SQL bulk plan", async () => {
    const sql = makeSqliteExecutor();
    const teams = new SqlTeamsRepository(sql);
    const deployments = new SqlDeploymentsRepository(sql);
    const plaintext = "ONE-TIME-CREATE-RESPONSE-KEY";
    await teams.putTeam({
      eventId: "EV1",
      teamId: "T1",
      tenantId: "tenant-acme",
      internalSlug: "team-1",
      teamLoginKey: plaintext,
      awsAccountId: "111111111111",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      expiresAt: 4_102_444_800,
    });
    const selectedTeams = await teams.listTeamsForDeployment("EV1");
    const plan = buildBulkDeployPlan({
      shared: sharedFor({ p1: "problems/challenges/p1" }),
      tenantId: "tenant-acme",
      eventId: "EV1",
      nowMs: NOW_MS,
      event: {},
      selected: {
        teams: selectedTeams,
        problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
      },
      existing: {
        failedByKey: new Map(),
        forceRedeployByKey: new Map(),
        existingKey: new Set(),
      },
      verified: new Map([
        [
          "111111111111",
          {
            awsAccountId: "111111111111",
            competitorRoleName: "DeployRole",
            region: "ap-northeast-1",
            externalIdParameterName: "/test/external-id",
            competitorRoleArn: "arn:aws:iam::111111111111:role/DeployRole",
          },
        ],
      ]),
      nonAwsCredentials: new Set(),
      retryFailedOnly: false,
      forceRedeploy: false,
    });

    await deployments.createBulkDeployments(
      "tenant-acme",
      plan.entries.map((entry) => ({ record: entry.item })),
    );

    expect((await deployments.listByTeamLoginKey(plaintext))[0]?.teamId).toBe("T1");
    const jobId = plan.entries[0]?.item.jobId;
    expect(jobId).toBeDefined();
    await deployments.markCreateInProgress(String(jobId), "2026-07-15T00:01:00.000Z");
    await deployments.markCreateSucceeded(
      String(jobId),
      "arn:aws:cloudformation:ap-northeast-1:111111111111:stack/test/id",
      "[]",
      undefined,
      "2026-07-15T00:02:00.000Z",
    );
    expect((await deployments.listByTeamLoginKey(plaintext))[0]).toMatchObject({
      teamId: "T1",
      status: "COMPLETE",
    });
    const row = await sql.get("SELECT payload FROM deployments LIMIT 1");
    expect(String(row?.payload)).not.toContain(plaintext);
    expect(JSON.parse(String(row?.payload))).not.toHaveProperty("teamLoginKeyHash");
  });
});
