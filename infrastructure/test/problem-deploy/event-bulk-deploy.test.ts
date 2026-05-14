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

/**
 * Phase 2.2 (Issue #459): bulk-deploy が CompetitorAccounts table を引いて verified=true
 * のみ許可するようになった。test helper 側で「verified account の集合」を default で
 * 「全 awsAccountId を許可」に倒し、unverified を試す test だけ override する形にする。
 *
 * 既存 test の `mockResolvedValueOnce` で順次 Event Get / Teams Query / 既存 deployments
 * Query / TransactWrite / UpdateCommand を返す順序は保てない (CompetitorAccounts Get が
 * Promise.all で並列に挟まる)。helper で `mockImplementation` を 1 度だけ仕掛け、
 * Command 種別 + TableName で振り分ける形に切り替える。
 */
const VERIFIED_ALL = Symbol("verified-all");
type VerifiedSet = Set<string> | typeof VERIFIED_ALL;

function buildShared(
  over: Partial<EventSharedResources> = {},
  verifiedAccounts: VerifiedSet = VERIFIED_ALL,
): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
  setVerifiedAccounts: (next: VerifiedSet) => void;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  let verified = verifiedAccounts;
  // CompetitorAccounts Get を `mockResolvedValueOnce` queue とは別経路で処理する。
  // ddbSend の queue が空 or 一致しない場合は CompetitorAccounts 用の verified record を返す。
  const originalSend = ddbSend;
  const wrappedSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const tn = (cmd as GetCommand).input.TableName;
      if (tn === "TestCompetitorAccounts") {
        const key = (cmd as GetCommand).input.Key ?? {};
        const sk = String(key.SK ?? "");
        const awsAccountId = sk.replace(/^ACCOUNT#/, "");
        const isVerified = verified === VERIFIED_ALL || verified.has(awsAccountId);
        if (!isVerified) return { Item: undefined };
        return {
          Item: {
            PK: key.PK,
            SK: key.SK,
            awsAccountId,
            region: "ap-northeast-1",
            competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
            verified: true,
          },
        };
      }
    }
    return originalSend(cmd);
  });
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: wrappedSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
      "hello-world-battle": "problems/battles/hello-world-battle",
    },
    ...over,
  };
  return {
    shared,
    ddbSend,
    eventsSend,
    setVerifiedAccounts: (next) => {
      verified = next;
    },
  };
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
    // #528: 各 team に独自 awsAccountId。test は 12 桁数字で 111... / 222... / ... と
    // pad して別 account を pin する。fallback test では明示的に外す。
    awsAccountId: `${i + 1}`.repeat(12).slice(0, 12),
  }));

describe("bulkDeployEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: teams × problems を全展開して deployment 行を Put + DeployCreateRequested を publish するべき", async () => {
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
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find(
        (c): c is TransactWriteCommand => c instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
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
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find(
        (c): c is TransactWriteCommand => c instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
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
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find(
        (c): c is TransactWriteCommand => c instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.Item?.eventStartsAt).toBeUndefined();
    }
  });

  it("#528: deployment 行の awsAccountId は **team** の awsAccountId を使うべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    const transactCmd = ddbSend.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0];
    const items = (transactCmd as TransactWriteCommand).input.TransactItems ?? [];
    // 2 teams × 2 problems = 4 items
    expect(items).toHaveLength(4);
    // T1 (awsAccountId=111111111111) と T2 (awsAccountId=222222222222) で別 account に
    const accountsByTeam = new Map<string, Set<string>>();
    for (const it of items) {
      const teamId = String(it.Put?.Item?.teamId ?? "");
      const acct = String(it.Put?.Item?.awsAccountId ?? "");
      if (!accountsByTeam.has(teamId)) accountsByTeam.set(teamId, new Set());
      accountsByTeam.get(teamId)?.add(acct);
    }
    // T1 の 2 deploy はすべて 111111111111、T2 の 2 deploy はすべて 222222222222
    expect([...(accountsByTeam.get("T1") ?? [])]).toEqual(["111111111111"]);
    expect([...(accountsByTeam.get("T2") ?? [])]).toEqual(["222222222222"]);
  });

  it("#528 migration: team.awsAccountId 無い旧 Event は problem.defaultAwsAccountId に fallback", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    // sampleTeams から awsAccountId を意図的に外す (旧 Event)
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          eventId: "EV1",
          teamId: "T1",
          tenantId: "tenant-acme",
          internalSlug: "team-1",
          teamLoginKey: "key-1",
        },
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0];
    const items = (transactCmd as TransactWriteCommand).input.TransactItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    // problem.defaultAwsAccountId (= 999999999999、sampleEvent 内) に fallback
    for (const it of items) {
      expect(it.Put?.Item?.awsAccountId).toBe("999999999999");
    }
  });

  it("#528: team.awsAccountId も problem.defaultAwsAccountId も無いと skip するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // problem.defaultAwsAccountId を外した event
    ddbSend.mockResolvedValueOnce({
      Item: sampleEvent({
        problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
      }),
    });
    // team.awsAccountId も無い旧 team
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          eventId: "EV1",
          teamId: "T1",
          tenantId: "tenant-acme",
          internalSlug: "team-1",
          teamLoginKey: "key-1",
        },
      ],
    });
    // #555: 既存 deployments query (空)
    ddbSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 1 team × 1 problem = 1、awsAccountId 無いので全 skip
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 1 } });
    expect(eventsSend).not.toHaveBeenCalled();
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

  // #555: 既存 (teamId, problemId) と衝突する組は再 PUT しない (= idempotent skip)
  it("既存 deployment 行と (eventId, teamId, problemId) が衝突する組は skipped に計上するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // 2 teams = 4 通り
    // 既存: T1×hello-world (COMPLETE) と T2×hello-world-battle (FAILED) は重複
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "OLD1", status: "COMPLETE" },
        { teamId: "T2", problemId: "hello-world-battle", jobId: "OLD2", status: "FAILED" },
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 4 通りのうち 2 件衝突、残り 2 件のみ enqueue
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 2, skipped: 2 } });
  });

  // #555: retryFailedOnly = true → FAILED 行のみ再生成、PENDING/COMPLETE はスルー
  it("retryFailedOnly = true は FAILED 行だけ DELETE + 新規 PENDING を CREATE するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // 2 teams = 4 通り
    // 既存 4 行のうち FAILED は 2 件
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "OLD-OK", status: "COMPLETE" },
        { teamId: "T1", problemId: "hello-world-battle", jobId: "OLD-FAIL-1", status: "FAILED" },
        { teamId: "T2", problemId: "hello-world", jobId: "OLD-FAIL-2", status: "FAILED" },
        { teamId: "T2", problemId: "hello-world-battle", jobId: "OLD-PENDING", status: "PENDING" },
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      retryFailedOnly: true,
    });
    // FAILED 2 件のみ再生成 (skipped は 0、retryFailedOnly は対象外を silent skip)
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 2, skipped: 0 } });

    // TransactWrite には Put (新) + Delete (旧 FAILED) が含まれる
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    expect(items).toHaveLength(4); // 2 Put + 2 Delete
    const puts = items.filter((it) => it.Put);
    const deletes = items.filter((it) => it.Delete);
    expect(puts).toHaveLength(2);
    expect(deletes).toHaveLength(2);
    // 旧 FAILED jobId が DELETE される
    const deletedKeys = deletes.map((d) => String(d.Delete?.Key?.PK ?? ""));
    expect(deletedKeys.sort()).toEqual(["DEPLOYMENT#OLD-FAIL-1", "DEPLOYMENT#OLD-FAIL-2"].sort());
    // Delete は tenantId condition で cross-tenant 削除を防ぐ
    for (const d of deletes) {
      expect(d.Delete?.ConditionExpression).toContain("tenantId");
      expect(d.Delete?.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    }
  });

  // #555: retryFailedOnly でも FAILED が無ければ何もしない
  it("retryFailedOnly = true で FAILED 行が 0 件なら enqueued=0 で write も publish もしないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "J1", status: "COMPLETE" },
        { teamId: "T2", problemId: "hello-world", jobId: "J2", status: "PENDING" },
      ],
    });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      retryFailedOnly: true,
    });
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 0 } });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // #555: teamIds で range を絞る (= 後追い team / 該当 team の env だけ deploy)
  it("teamIds 指定 で指定 team のみ deploy するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) }); // 3 teams、うち T2 のみ deploy
    ddbSend.mockResolvedValueOnce({ Items: [] }); // 既存 deployments 無し
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      teamIds: ["T2"],
    });
    // 1 team × 2 problems = 2
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 2, skipped: 0 } });

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    for (const it of items) {
      expect(it.Put?.Item?.teamId).toBe("T2");
    }
  });

  // #555: problemIds で range を絞る (= 後追い問題 / 修正済問題だけ deploy)
  it("problemIds 指定 で指定 problem のみ deploy するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // 2 teams、うち hello-world のみ
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      problemIds: ["hello-world"],
    });
    // 2 teams × 1 problem = 2
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 2, skipped: 0 } });

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    for (const it of items) {
      expect(it.Put?.Item?.problemId).toBe("hello-world");
    }
  });

  // #555: retryFailedOnly + teamIds の組み合わせ (= 特定 team の失敗だけ retry)
  it("retryFailedOnly + teamIds の組み合わせで指定 team の FAILED だけ retry するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // T1, T2
    // T1 / T2 とも FAILED あり、だが teamIds で T1 のみに絞る
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "F1", status: "FAILED" },
        { teamId: "T2", problemId: "hello-world", jobId: "F2", status: "FAILED" },
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      retryFailedOnly: true,
      teamIds: ["T1"],
    });
    // T1 × hello-world のみ retry (= 1 件)
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 1, skipped: 0 } });

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    // 1 Put + 1 Delete = 2 items
    expect(items).toHaveLength(2);
    const put = items.find((it) => it.Put);
    expect(put?.Put?.Item?.teamId).toBe("T1");
    const del = items.find((it) => it.Delete);
    expect(del?.Delete?.Key?.PK).toBe("DEPLOYMENT#F1");
  });

  // Phase 2.2 (Issue #459) Worker cross-account 化:
  // CompetitorAccounts table で verified=true 行が無い awsAccountId は reject されるべき
  it("verified=false / 未登録の awsAccountId は plan から落ちて unverified に計上するべき", async () => {
    const { shared, ddbSend, eventsSend, setVerifiedAccounts } = buildShared();
    // T1 (111111111111) のみ verified、T2 (222222222222) は未登録
    setVerifiedAccounts(new Set(["111111111111"]));
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // T1, T2
    ddbSend.mockResolvedValueOnce({ Items: [] }); // 既存 deployments 空
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // T1×2 problems = 2 enqueue、T2×2 problems = 2 reject、unverified set は {222...}
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(2);
    expect(out.result.unverified).toBe(1);
    expect(out.result.unverifiedAccounts).toEqual(["222222222222"]);

    // sampleEvent の problem.defaultAwsAccountId (= 999999999999) もあるが、team.awsAccountId
    // が両 team とも埋まっているので fallback は使われない → 999... は plan に来ない。
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    for (const it of items) {
      expect(it.Put?.Item?.awsAccountId).toBe("111111111111");
      expect(it.Put?.Item?.competitorRoleArn).toBe(
        "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
      );
    }
  });

  // Phase 2.2: 全 team が unverified なら write も publish もしない (fail-closed)
  it("全 team が unverified なら write / publish せず enqueued=0 で返すべき", async () => {
    const { shared, ddbSend, eventsSend, setVerifiedAccounts } = buildShared();
    setVerifiedAccounts(new Set()); // verified なし
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(0);
    expect(out.result.unverified).toBe(2);
    expect(out.result.unverifiedAccounts).toEqual(["111111111111", "222222222222"]);
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // Phase 2.2: DeployCreateRequested の detail に competitorRoleArn / externalIdParameterName を埋めるべき
  it("DeployCreateRequested detail に AssumeRole 用の competitorRoleArn と externalIdParameterName を含めるべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) }); // T1 only
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const putCmd = eventsSend.mock.calls
      .map((c) => c[0])
      .find((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    const detailRaw = putCmd?.input.Entries?.[0]?.Detail;
    expect(detailRaw).toBeDefined();
    const detail = JSON.parse(String(detailRaw ?? "{}"));
    // T1 awsAccountId は 111111111111、SSM path は `/development/tenants/tenant-acme/external-id`
    expect(detail.competitorRoleArn).toBe(
      "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(detail.externalIdParameterName).toBe("/development/tenants/tenant-acme/external-id");
  });
});
