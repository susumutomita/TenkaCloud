import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #557 / #539: HealthCheck Lambda の Event status auto-transition reconciler の test。
 *
 * 2 階層に分けて test する:
 *   1. `resolveEventStatusTransition` (pure function、入出力のみ) — 8 ケース
 *   2. `reconcileEventStatuses` (DDB mock 越し) — Scan → Query × N → conditional Update の
 *      シーケンスを pin
 *
 * mock した DDB に対して Scan / Query / Update Command を発行する順序と引数を assert する。
 */

const ddbSend = vi.fn();

vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({ send: ddbSend }),
    },
  };
});

// env を読む関数は遅延 lookup なので、module load 時に env が無くてもよい。test 内で set。
process.env.DEPLOYMENTS_TABLE_NAME = "TestDeployments";
process.env.EVENTS_TABLE_NAME = "TestEvents";

const { reconcileEventStatuses, resolveEventStatusTransition } = await import(
  "../../lib/problem-deploy/handlers/health-check-handler/index"
);

describe("resolveEventStatusTransition (#557 #539 pure logic)", () => {
  it("DEPLOYING + 全 COMPLETE → READY", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "COMPLETE"])).toBe("READY");
  });

  it("DEPLOYING + COMPLETE/FAILED 混在 → READY (FAILED も terminal 扱い)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "FAILED", "COMPLETE"])).toBe(
      "READY",
    );
  });

  it("DEPLOYING + PENDING が 1 件でも残る → undefined (= まだ動かさない)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "PENDING"])).toBeUndefined();
  });

  it("DEPLOYING + IN_PROGRESS が残る → undefined", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "IN_PROGRESS"])).toBeUndefined();
  });

  it("TEARDOWN + 全 DELETED → ARCHIVED", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETED"])).toBe("ARCHIVED");
  });

  it("TEARDOWN + DELETED/FAILED 混在 → ARCHIVED (= teardown 失敗行も引きずらない)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "FAILED"])).toBe("ARCHIVED");
  });

  it("TEARDOWN + DELETING が残る → undefined (= まだ削除中)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETING"])).toBeUndefined();
  });

  it("子 deployment 0 件 → undefined (= bulk-deploy/delete 前の race state、触らない)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", [])).toBeUndefined();
    expect(resolveEventStatusTransition("TEARDOWN", [])).toBeUndefined();
  });

  it("対象外 status (DRAFT / READY / ENDED / ARCHIVED) は defense-in-depth で undefined", () => {
    expect(resolveEventStatusTransition("DRAFT", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("READY", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("ENDED", ["DELETED"])).toBeUndefined();
    expect(resolveEventStatusTransition("ARCHIVED", ["DELETED"])).toBeUndefined();
  });
});

const NOW_ISO = "2026-05-11T00:00:00.000Z";

describe("reconcileEventStatuses (#557 #539 DDB integration)", () => {
  beforeEach(() => ddbSend.mockReset());
  afterEach(() => ddbSend.mockReset());

  it("DEPLOYING で子 deployments 全 COMPLETE → Update で READY に遷移", async () => {
    // 1. Scan Events: 1 件 DEPLOYING を返す
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV1", tenantId: "tenant-acme", eventId: "EV1", status: "DEPLOYING" }],
      LastEvaluatedKey: undefined,
    });
    // 2. Query Deployments: 2 件 COMPLETE
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "COMPLETE" }],
    });
    // 3. Update Events: 成功
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(NOW_ISO);

    expect(ddbSend).toHaveBeenCalledTimes(3);
    const updateCmd = ddbSend.mock.calls[2]?.[0] as {
      input: {
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    expect(updateCmd.input.UpdateExpression).toContain("SET #status = :next");
    expect(updateCmd.input.ExpressionAttributeValues[":next"]).toBe("READY");
    expect(updateCmd.input.ExpressionAttributeValues[":current"]).toBe("DEPLOYING");
    expect(updateCmd.input.ConditionExpression).toContain("tenantId = :tenant");
    expect(updateCmd.input.ConditionExpression).toContain("#status = :current");
  });

  it("TEARDOWN で子 deployments 全 DELETED → Update で ARCHIVED に遷移", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV2", tenantId: "tenant-acme", eventId: "EV2", status: "TEARDOWN" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "DELETED" }, { status: "DELETED" }, { status: "DELETED" }],
    });
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(NOW_ISO);

    const updateCmd = ddbSend.mock.calls[2]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(updateCmd.input.ExpressionAttributeValues[":next"]).toBe("ARCHIVED");
    expect(updateCmd.input.ExpressionAttributeValues[":current"]).toBe("TEARDOWN");
  });

  it("DEPLOYING で PENDING が残る → Update を発行しない (= まだ READY ではない)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV3", tenantId: "tenant-acme", eventId: "EV3", status: "DEPLOYING" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "PENDING" }],
    });

    await reconcileEventStatuses(NOW_ISO);

    // 2 calls (Scan + Query)。Update は走らない
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("複数 Event を **並列** に処理する (= 1 件遅延が他を block しない)", async () => {
    // Scan: 2 Event (DEPLOYING + TEARDOWN、それぞれ READY / ARCHIVED 候補)
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "EVENT#A", tenantId: "tenant-acme", eventId: "A", status: "DEPLOYING" },
        { PK: "EVENT#B", tenantId: "tenant-acme", eventId: "B", status: "TEARDOWN" },
      ],
    });
    // Query を Command 内容で出し分け: Event A は COMPLETE、Event B は DELETED
    ddbSend.mockImplementation(
      async (cmd: { input?: { ExpressionAttributeValues?: Record<string, string> } }) => {
        const ev = cmd.input?.ExpressionAttributeValues?.[":ev"];
        if (ev === "A") return { Items: [{ status: "COMPLETE" }] };
        if (ev === "B") return { Items: [{ status: "DELETED" }] };
        return {}; // Update 等の他 command は無事返す
      },
    );

    await reconcileEventStatuses(NOW_ISO);

    // 1 Scan + 2 Query + 2 Update = 5 calls (= 並列 fan-out が走った証拠)
    expect(ddbSend).toHaveBeenCalledTimes(5);
  });

  it("Event 更新の CCF (= operator race) は throw せず silent skip", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV4", tenantId: "tenant-acme", eventId: "EV4", status: "DEPLOYING" }],
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ status: "COMPLETE" }] });
    // Update が CCF を throw — race 状態
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    // 例外が外に漏れずに完了する
    await expect(reconcileEventStatuses(NOW_ISO)).resolves.toBeUndefined();
  });

  it("Scan が pagination する (= LastEvaluatedKey 有り → 次 Scan)", async () => {
    // 1 ページ目: 1 Event + LastEvaluatedKey 有り
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#P1", tenantId: "t", eventId: "P1", status: "DEPLOYING" }],
      LastEvaluatedKey: { PK: "cursor" },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ status: "COMPLETE" }] });
    ddbSend.mockResolvedValueOnce({}); // Update
    // 2 ページ目: 0 件 + LastEvaluatedKey 無し
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await reconcileEventStatuses(NOW_ISO);

    // 1 Scan + 1 Query + 1 Update + 1 Scan = 4 calls
    expect(ddbSend).toHaveBeenCalledTimes(4);
    // 2 回目 Scan の ExclusiveStartKey が 1 回目の LastEvaluatedKey と一致
    const scan2 = ddbSend.mock.calls[3]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(scan2.input.ExclusiveStartKey).toEqual({ PK: "cursor" });
  });

  it("Event filter は DEPLOYING または TEARDOWN のみ (= READY / ENDED は触らない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await reconcileEventStatuses(NOW_ISO);

    const scanCmd = ddbSend.mock.calls[0]?.[0] as {
      input: {
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    expect(scanCmd.input.FilterExpression).toBe("#status = :deploying OR #status = :teardown");
    expect(scanCmd.input.ExpressionAttributeValues[":deploying"]).toBe("DEPLOYING");
    expect(scanCmd.input.ExpressionAttributeValues[":teardown"]).toBe("TEARDOWN");
  });
});
