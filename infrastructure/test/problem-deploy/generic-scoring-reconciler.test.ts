import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
  resolveEventStatusTransition,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";

/**
 * #557 / #539: Event status auto-transition reconciler の test (ADR-012 Phase 3.B で
 * health-check-handler から `generic-scoring-handler/event-reconciler.ts` に relocate)。
 *
 * 2 階層に分けて test する:
 *   1. `resolveEventStatusTransition` (pure function)
 *   2. `reconcileEventStatuses` (DDB mock 越し)
 */

describe("resolveEventStatusTransition (#557 #539 pure logic)", () => {
  it("DEPLOYING + 全 COMPLETE なら READY に遷移すべき", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "COMPLETE"])).toBe("READY");
  });

  it("DEPLOYING + COMPLETE/FAILED 混在なら READY に遷移すべき (FAILED も terminal 扱い)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "FAILED", "COMPLETE"])).toBe(
      "READY",
    );
  });

  it("DEPLOYING + PENDING が 1 件でも残るなら undefined を返すべき (= まだ動かさない)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "PENDING"])).toBeUndefined();
  });

  it("DEPLOYING + IN_PROGRESS が残るなら undefined を返すべき", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "IN_PROGRESS"])).toBeUndefined();
  });

  it("TEARDOWN + 全 DELETED なら ARCHIVED に遷移すべき", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETED"])).toBe("ARCHIVED");
  });

  it("TEARDOWN + DELETED/FAILED 混在なら ARCHIVED に遷移すべき (= teardown 失敗行も引きずらない)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "FAILED"])).toBe("ARCHIVED");
  });

  it("TEARDOWN + DELETING が残るなら undefined を返すべき (= まだ削除中)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETING"])).toBeUndefined();
  });

  it("子 deployment 0 件なら undefined を返すべき (= bulk-deploy/delete 前の race state、 触らない)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", [])).toBeUndefined();
    expect(resolveEventStatusTransition("TEARDOWN", [])).toBeUndefined();
  });

  it("対象外 status (DRAFT / READY / ENDED / ARCHIVED) は defense-in-depth で undefined を返すべき", () => {
    expect(resolveEventStatusTransition("DRAFT", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("READY", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("ENDED", ["DELETED"])).toBeUndefined();
    expect(resolveEventStatusTransition("ARCHIVED", ["DELETED"])).toBeUndefined();
  });
});

const NOW_ISO = "2026-05-11T00:00:00.000Z";

function buildCtx(): { ctx: ReconcileEventStatusesContext; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const ctx: ReconcileEventStatusesContext = {
    ddb: { send: ddbSend } as unknown as ReconcileEventStatusesContext["ddb"],
    eventsTableName: "TestEvents",
    deploymentsTableName: "TestDeployments",
  };
  return { ctx, ddbSend };
}

describe("reconcileEventStatuses (#557 #539 DDB integration)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });
  afterEach(() => ddbSend.mockReset());

  it("DEPLOYING で子 deployments 全 COMPLETE → Update で READY に遷移すべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV1", tenantId: "tenant-acme", eventId: "EV1", status: "DEPLOYING" }],
      LastEvaluatedKey: undefined,
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "COMPLETE" }],
    });
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, NOW_ISO);

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

  it("TEARDOWN で子 deployments 全 DELETED → Update で ARCHIVED に遷移すべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV2", tenantId: "tenant-acme", eventId: "EV2", status: "TEARDOWN" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "DELETED" }, { status: "DELETED" }, { status: "DELETED" }],
    });
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, NOW_ISO);

    const updateCmd = ddbSend.mock.calls[2]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(updateCmd.input.ExpressionAttributeValues[":next"]).toBe("ARCHIVED");
    expect(updateCmd.input.ExpressionAttributeValues[":current"]).toBe("TEARDOWN");
  });

  it("DEPLOYING で PENDING が残る → Update を発行しないべき (= まだ READY ではない)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV3", tenantId: "tenant-acme", eventId: "EV3", status: "DEPLOYING" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "PENDING" }],
    });

    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("複数 Event を **並列** に処理すべき (= 1 件遅延が他を block しない)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "EVENT#A", tenantId: "tenant-acme", eventId: "A", status: "DEPLOYING" },
        { PK: "EVENT#B", tenantId: "tenant-acme", eventId: "B", status: "TEARDOWN" },
      ],
    });
    ddbSend.mockImplementation(
      async (cmd: { input?: { ExpressionAttributeValues?: Record<string, string> } }) => {
        const ev = cmd.input?.ExpressionAttributeValues?.[":ev"];
        if (ev === "A") return { Items: [{ status: "COMPLETE" }] };
        if (ev === "B") return { Items: [{ status: "DELETED" }] };
        return {};
      },
    );

    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(5);
  });

  it("Event 更新の CCF (= operator race) は throw せず silent skip すべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV4", tenantId: "tenant-acme", eventId: "EV4", status: "DEPLOYING" }],
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ status: "COMPLETE" }] });
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });
    await expect(reconcileEventStatuses(ctx, NOW_ISO)).resolves.toBeUndefined();
  });

  it("Scan が pagination するべき (= LastEvaluatedKey 有り → 次 Scan)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#P1", tenantId: "t", eventId: "P1", status: "DEPLOYING" }],
      LastEvaluatedKey: { PK: "cursor" },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ status: "COMPLETE" }] });
    ddbSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(4);
    const scan2 = ddbSend.mock.calls[3]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(scan2.input.ExclusiveStartKey).toEqual({ PK: "cursor" });
  });

  it("Deployment Query が pagination するべき (= Filter 後の空 page を越えて READY 判定する)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-PAGED",
          tenantId: "tenant-acme",
          eventId: "EV-PAGED",
          status: "DEPLOYING",
        },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { GSI1PK: "TENANT#tenant-acme", GSI1SK: "cursor" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "COMPLETE" }],
    });
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(ddbSend).toHaveBeenCalledTimes(4);
    const query1 = ddbSend.mock.calls[1]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    const query2 = ddbSend.mock.calls[2]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    const updateCmd = ddbSend.mock.calls[3]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(query1.input.ExclusiveStartKey).toBeUndefined();
    expect(query2.input.ExclusiveStartKey).toEqual({
      GSI1PK: "TENANT#tenant-acme",
      GSI1SK: "cursor",
    });
    expect(updateCmd.input.ExpressionAttributeValues[":next"]).toBe("READY");
  });

  it("Deployment Query の後続 page に非 terminal があれば READY にしないべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-PENDING",
          tenantId: "tenant-acme",
          eventId: "EV-PENDING",
          status: "DEPLOYING",
        },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }],
      LastEvaluatedKey: { GSI1PK: "TENANT#tenant-acme", GSI1SK: "cursor" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "PENDING" }],
    });

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(ddbSend).toHaveBeenCalledTimes(3);
    const query2 = ddbSend.mock.calls[2]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(query2.input.ExclusiveStartKey).toEqual({
      GSI1PK: "TENANT#tenant-acme",
      GSI1SK: "cursor",
    });
  });

  it("Event filter は DEPLOYING または TEARDOWN のみであるべき (= READY / ENDED は触らない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await reconcileEventStatuses(ctx, NOW_ISO);
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
