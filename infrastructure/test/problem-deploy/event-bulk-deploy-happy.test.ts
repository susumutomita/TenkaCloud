import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

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
});
