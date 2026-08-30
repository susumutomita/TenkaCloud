import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

describe("bulkDeployEvent — idempotency, retry & range filters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should prevent double creation on the same jobId via ConditionExpression on each deployment row", async () => {
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

  // #555: 既存 (teamId, problemId) と衝突する組は再 PUT しない (= idempotent skip)
  it("should count combinations colliding with existing deployment rows on (eventId, teamId, problemId) as skipped", async () => {
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

  it("should not write / publish on duplicate event when every combination is already PENDING", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) }); // 1 team = 2 通り
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "P1", status: "PENDING" },
        { teamId: "T1", problemId: "hello-world-battle", jobId: "P2", status: "PENDING" },
      ],
    });
    ddbSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 2 } });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // #555: retryFailedOnly = true → FAILED 行のみ再生成、PENDING/COMPLETE はスルー
  it("should DELETE only FAILED rows and CREATE new PENDING rows when retryFailedOnly = true", async () => {
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
  it("should return enqueued=0 without writing or publishing when retryFailedOnly = true and there are 0 FAILED rows", async () => {
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

  // #756: forceRedeploy = true → COMPLETE 済み stack を新 template で update し直す
  it("should DELETE COMPLETE rows and CREATE new PENDING rows when forceRedeploy = true", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // 2 teams = 4 通り
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", problemId: "hello-world", jobId: "OLD-COMPLETE", status: "COMPLETE" },
        { teamId: "T2", problemId: "hello-world-battle", jobId: "OLD-PENDING", status: "PENDING" },
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS, {
      forceRedeploy: true,
    });

    // COMPLETE は置換、未作成 2 件は通常 deploy、PENDING 1 件は skip。
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 3, skipped: 1 } });

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    expect(items.filter((it) => it.Put)).toHaveLength(3);
    const deletes = items.filter((it) => it.Delete);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.Delete?.Key?.PK).toBe("DEPLOYMENT#OLD-COMPLETE");
    expect(deletes[0]?.Delete?.ConditionExpression).toContain("tenantId");
    expect(deletes[0]?.Delete?.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    const coordinationDeletes = ddbSend.mock.calls
      .map((call) => call[0])
      .filter((command): command is DeleteCommand => command instanceof DeleteCommand);
    expect(coordinationDeletes).toHaveLength(2);
    expect(
      coordinationDeletes.some((command) =>
        String(command.input.Key?.PK).includes("#hello-world#default"),
      ),
    ).toBe(true);
  });

  // #555: teamIds で range を絞る (= 後追い team / 該当 team の env だけ deploy)
  it("should deploy only the specified teams when teamIds is supplied", async () => {
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
  it("should deploy only the specified problems when problemIds is supplied", async () => {
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
  it("should retry only FAILED rows for the specified team when retryFailedOnly + teamIds are combined", async () => {
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
});
