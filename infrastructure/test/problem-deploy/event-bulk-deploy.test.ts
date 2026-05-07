import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;

function buildShared(over: Partial<EventSharedResources> = {}): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
      "hello-world-battle": "problems/battles/hello-world-battle",
    },
    ...over,
  };
  return { shared, ddbSend, eventsSend };
}

const sampleEvent = (over: Record<string, unknown> = {}) => ({
  eventId: "EV1",
  tenantId: "tenant-acme",
  name: "Spring 2026",
  status: "DRAFT",
  problems: [
    {
      problemId: "hello-world",
      defaultAwsAccountId: "999999999999",
      defaultRegion: "ap-northeast-1",
    },
    {
      problemId: "hello-world-battle",
      defaultAwsAccountId: "999999999999",
      defaultRegion: "us-east-1",
    },
  ],
  ...over,
});

const sampleTeams = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    eventId: "EV1",
    teamId: `T${i + 1}`,
    tenantId: "tenant-acme",
    internalSlug: `team-${i + 1}`,
    teamLoginKey: `key-${i + 1}`,
  }));

describe("bulkDeployEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: teams × problems を全展開して deployment 行を Put + DeployCreateRequested を publish するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // GetCommand
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) }); // QueryCommand teams
    ddbSend.mockResolvedValue({}); // TransactWrite chunks (1 chunk for 6 items)
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
    // 3 件目: TransactWriteCommand (6 items / 1 chunk)
    const transactCmd = ddbSend.mock.calls[2]?.[0] as TransactWriteCommand;
    expect(transactCmd).toBeInstanceOf(TransactWriteCommand);
    expect(transactCmd.input.TransactItems).toHaveLength(6);

    // 各 item に eventId / teamId / teamLoginKey が入る
    const firstItem = transactCmd.input.TransactItems?.[0]?.Put?.Item;
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

  it("event 不在は not_found を返し DDB write / publish しないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("tenantId 不一致は not_found を返し書き込みを行わないべき (クロステナント漏洩防止)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ tenantId: "tenant-other" }) });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("teams または problems が 0 件なら enqueued=0 を返し書き込みしないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ problems: [] }) });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 0 } });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("カタログにない problemId は skipped にカウントするべき", async () => {
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

  it("TransactWrite は 25 items 上限で chunk 化するべき", async () => {
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

  it("PutEvents は 10 entries 上限で chunk 化するべき", async () => {
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

  it("各 deployment 行の ConditionExpression で同 jobId 二重生成を防ぐべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls[2]?.[0] as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    }
  });

  it("Event.startsAt を deployment 行に eventStartsAt として denormalize するべき", async () => {
    // operator が Bulk Deploy 前に schedule 済 (startsAt 設定済) だった場合、
    // 新規 deployment 行が gate 値を持って作られるシナリオ。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleEvent({ startsAt: "2026-05-08T10:00:00.000Z" }),
    });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls[2]?.[0] as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.Item?.eventStartsAt).toBe("2026-05-08T10:00:00.000Z");
    }
  });

  it("Event.startsAt 未設定の場合は eventStartsAt も undefined (採点 gate に倒す)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // startsAt 無し
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls[2]?.[0] as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.Item?.eventStartsAt).toBeUndefined();
    }
  });

  it("成功後に Event status を DRAFT → DEPLOYING に倒すべき (status badge 視認用)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmds).toHaveLength(1);
    const cmd = updateCmds[0] as UpdateCommand;
    expect(cmd.input.UpdateExpression).toContain("#status = :deploying");
    expect(cmd.input.ExpressionAttributeValues?.[":deploying"]).toBe("DEPLOYING");
    // TEARDOWN/ARCHIVED は触らない (ConditionExpression で DRAFT/READY/DEPLOYING のみ許可)
    expect(cmd.input.ExpressionAttributeValues?.[":draft"]).toBe("DRAFT");
    expect(cmd.input.ExpressionAttributeValues).not.toHaveProperty(":teardown");
  });
});
