import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStuckDeletingForTeardown,
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
  rescueStuckDeletingDeployments,
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
  it("should transition to READY when DEPLOYING + all COMPLETE", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "COMPLETE"])).toBe("READY");
  });

  it("should transition to READY on DEPLOYING + mixed COMPLETE/FAILED (FAILED treated as terminal)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "FAILED", "COMPLETE"])).toBe(
      "READY",
    );
  });

  it("should return undefined when even one DEPLOYING + PENDING remains (don't move yet)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "PENDING"])).toBeUndefined();
  });

  it("should return undefined when DEPLOYING + IN_PROGRESS remain", () => {
    expect(resolveEventStatusTransition("DEPLOYING", ["COMPLETE", "IN_PROGRESS"])).toBeUndefined();
  });

  it("should transition to ARCHIVED on TEARDOWN + all DELETED", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETED"])).toBe("ARCHIVED");
  });

  it("should transition to ARCHIVED on TEARDOWN + mixed DELETED/FAILED (don't drag teardown failures)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "FAILED"])).toBe("ARCHIVED");
  });

  it("should return undefined when TEARDOWN + DELETING remain (still deleting)", () => {
    expect(resolveEventStatusTransition("TEARDOWN", ["DELETED", "DELETING"])).toBeUndefined();
  });

  it("should return undefined when child deployments are 0 (pre-bulk-deploy/delete race state, don't touch)", () => {
    expect(resolveEventStatusTransition("DEPLOYING", [])).toBeUndefined();
    expect(resolveEventStatusTransition("TEARDOWN", [])).toBeUndefined();
  });

  it("should return undefined for out-of-scope status (DRAFT / ENDED / ARCHIVED) (defense in depth)", () => {
    expect(resolveEventStatusTransition("DRAFT", ["COMPLETE"])).toBeUndefined();
    expect(resolveEventStatusTransition("ENDED", ["DELETED"])).toBeUndefined();
    expect(resolveEventStatusTransition("ARCHIVED", ["DELETED"])).toBeUndefined();
  });

  // Issue #1038 P0 #3: READY + endsAt 経過の自動 ENDED 遷移
  it("should transition to ENDED when READY + endsAt is past now", () => {
    const endsAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse("2026-05-15T00:00:01.000Z");
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBe("ENDED");
  });

  it("should transition to ENDED when READY + endsAt equals now (boundary inclusive)", () => {
    const endsAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse(endsAt);
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBe("ENDED");
  });

  it("should return undefined when READY + endsAt is still in the future (don't touch)", () => {
    const endsAt = "2026-05-15T01:00:00.000Z";
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(resolveEventStatusTransition("READY", [], { endsAt, nowMs })).toBeUndefined();
  });

  it("should return undefined when READY + endsAt is absent (don't touch open-ended events)", () => {
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(resolveEventStatusTransition("READY", [], { nowMs })).toBeUndefined();
  });

  it("should return undefined for READY + invalid endsAt (unparseable)", () => {
    const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    expect(
      resolveEventStatusTransition("READY", [], { endsAt: "not-a-date", nowMs }),
    ).toBeUndefined();
  });

  it("should return undefined for READY without context (legacy caller compat)", () => {
    expect(resolveEventStatusTransition("READY", [])).toBeUndefined();
    expect(resolveEventStatusTransition("READY", ["COMPLETE"])).toBeUndefined();
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

  it("should transition to READY via Update when DEPLOYING and all child deployments are COMPLETE", async () => {
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

  it("should transition to ARCHIVED via Update when TEARDOWN and all child deployments are DELETED", async () => {
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

  it("should not issue Update when DEPLOYING with PENDING remaining (not READY yet)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#EV3", tenantId: "tenant-acme", eventId: "EV3", status: "DEPLOYING" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ status: "COMPLETE" }, { status: "PENDING" }],
    });

    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("should process multiple Events **in parallel** (one slow event must not block others)", async () => {
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

  it("should silently skip without throwing on Event update CCF (operator race)", async () => {
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

  it("Scan should paginate (with LastEvaluatedKey → next Scan)", async () => {
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

  it("Deployment Query should paginate (judging READY across empty pages after filtering)", async () => {
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

  it("should not mark READY if subsequent Deployment Query pages contain non-terminal rows", async () => {
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

  // Issue #828: stuck DELETING rescue path の test
  it("should rescue stuck `DELETING` rows for 30+ min to FAILED and transition to ARCHIVED during TEARDOWN", async () => {
    const now = "2026-05-15T01:00:00.000Z";
    const stale = "2026-05-15T00:25:00.000Z"; // 35 min 前 (= threshold 30 min を超過)
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "EVENT#EV-STUCK", tenantId: "tenant-acme", eventId: "EV-STUCK", status: "TEARDOWN" },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#FRESH", status: "DELETED", updatedAt: now },
        { PK: "DEPLOYMENT#STUCK", status: "DELETING", updatedAt: stale },
      ],
    });
    // rescue UpdateItem (= stuck row を FAILED に倒す)
    ddbSend.mockResolvedValueOnce({});
    // event Update (= TEARDOWN → ARCHIVED)
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, now);

    expect(ddbSend).toHaveBeenCalledTimes(4);
    const rescueCmd = ddbSend.mock.calls[2]?.[0] as {
      input: {
        TableName: string;
        Key: Record<string, string>;
        ExpressionAttributeValues: Record<string, string>;
        ConditionExpression: string;
      };
    };
    expect(rescueCmd.input.TableName).toBe("TestDeployments");
    expect(rescueCmd.input.Key).toEqual({ PK: "DEPLOYMENT#STUCK", SK: "META" });
    expect(rescueCmd.input.ExpressionAttributeValues[":failed"]).toBe("FAILED");
    expect(rescueCmd.input.ExpressionAttributeValues[":deleting"]).toBe("DELETING");
    expect(rescueCmd.input.ConditionExpression).toContain("#status = :deleting");
    const eventUpdate = ddbSend.mock.calls[3]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(eventUpdate.input.ExpressionAttributeValues[":next"]).toBe("ARCHIVED");
  });

  it("should not trigger rescue or ARCHIVED transition during TEARDOWN when `DELETING` is below threshold (still deleting)", async () => {
    const now = "2026-05-15T01:00:00.000Z";
    const recent = "2026-05-15T00:50:00.000Z"; // 10 min 前 (= threshold 未満)
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "EVENT#EV-FRESH", tenantId: "tenant-acme", eventId: "EV-FRESH", status: "TEARDOWN" },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#A", status: "DELETED", updatedAt: now },
        { PK: "DEPLOYMENT#B", status: "DELETING", updatedAt: recent },
      ],
    });

    await reconcileEventStatuses(ctx, now);

    // Scan + Query のみで Update は無し (= rescue も transition も skip)
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("`isStuckDeletingForTeardown` pure logic should combine eventStatus / status / threshold", () => {
    const nowMs = Date.parse("2026-05-15T01:00:00.000Z");
    const stale = "2026-05-15T00:00:00.000Z"; // 60 min 前
    const recent = "2026-05-15T00:55:00.000Z"; // 5 min 前
    // 該当
    expect(
      isStuckDeletingForTeardown("TEARDOWN", { status: "DELETING", updatedAt: stale }, nowMs),
    ).toBe(true);
    // eventStatus が TEARDOWN 以外
    expect(
      isStuckDeletingForTeardown("DEPLOYING", { status: "DELETING", updatedAt: stale }, nowMs),
    ).toBe(false);
    // status が DELETING 以外
    expect(
      isStuckDeletingForTeardown("TEARDOWN", { status: "DELETED", updatedAt: stale }, nowMs),
    ).toBe(false);
    // updatedAt が threshold 未満
    expect(
      isStuckDeletingForTeardown("TEARDOWN", { status: "DELETING", updatedAt: recent }, nowMs),
    ).toBe(false);
    // updatedAt 未設定 (= 旧 row) は safe default で false
    expect(isStuckDeletingForTeardown("TEARDOWN", { status: "DELETING" }, nowMs)).toBe(false);
    // nowMs が NaN なら false (= 異常入力で副作用を出さない)
    expect(
      isStuckDeletingForTeardown("TEARDOWN", { status: "DELETING", updatedAt: stale }, Number.NaN),
    ).toBe(false);
  });

  it("`rescueStuckDeletingDeployments` should skip rescue for rows missing PK (projection-leak safety)", async () => {
    const nowMs = Date.parse("2026-05-15T01:00:00.000Z");
    await rescueStuckDeletingDeployments(
      ctx,
      [{ status: "DELETING", updatedAt: "2026-05-15T00:00:00.000Z" }],
      nowMs,
    );
    // PK 無しは silent skip (= UpdateItem 発火しない)
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("`rescueStuckDeletingDeployments` should silently skip on UpdateItem CCF (= concurrent MarkDeleted/MarkFailed)", async () => {
    const nowMs = Date.parse("2026-05-15T01:00:00.000Z");
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });
    await expect(
      rescueStuckDeletingDeployments(
        ctx,
        [
          {
            PK: "DEPLOYMENT#X",
            status: "DELETING",
            updatedAt: "2026-05-15T00:00:00.000Z",
          },
        ],
        nowMs,
      ),
    ).resolves.toBe(0);
  });

  it("Event filter should target DEPLOYING / READY / TEARDOWN (don't touch ENDED / ARCHIVED)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await reconcileEventStatuses(ctx, NOW_ISO);
    const scanCmd = ddbSend.mock.calls[0]?.[0] as {
      input: {
        ProjectionExpression: string;
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    expect(scanCmd.input.FilterExpression).toBe(
      "#status = :deploying OR #status = :ready OR #status = :teardown",
    );
    expect(scanCmd.input.ExpressionAttributeValues[":deploying"]).toBe("DEPLOYING");
    expect(scanCmd.input.ExpressionAttributeValues[":ready"]).toBe("READY");
    expect(scanCmd.input.ExpressionAttributeValues[":teardown"]).toBe("TEARDOWN");
    // Issue #1038 P0 #3: READY → ENDED 判定に endsAt が要るので projection に含める
    expect(scanCmd.input.ProjectionExpression).toContain("endsAt");
  });

  // Issue #1038 P0 #3: READY + endsAt 経過で自動 ENDED 遷移
  it("should transition to ENDED via Update when READY and endsAt is past now (don't query deployment rows)", async () => {
    const now = "2026-05-15T01:00:00.000Z";
    const pastEnd = "2026-05-15T00:30:00.000Z";
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-DUE",
          tenantId: "tenant-acme",
          eventId: "EV-DUE",
          status: "READY",
          endsAt: pastEnd,
        },
      ],
    });
    // READY 経路は deployment Query を skip し、 直接 Update に進む。
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, now);

    expect(ddbSend).toHaveBeenCalledTimes(2);
    const updateCmd = ddbSend.mock.calls[1]?.[0] as {
      input: {
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    expect(updateCmd.input.ExpressionAttributeValues[":next"]).toBe("ENDED");
    expect(updateCmd.input.ExpressionAttributeValues[":current"]).toBe("READY");
    expect(updateCmd.input.ConditionExpression).toContain("#status = :current");
  });

  it("should not issue Update when READY and endsAt is still in the future", async () => {
    const now = "2026-05-15T00:00:00.000Z";
    const future = "2026-05-15T01:00:00.000Z";
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-LIVE",
          tenantId: "tenant-acme",
          eventId: "EV-LIVE",
          status: "READY",
          endsAt: future,
        },
      ],
    });

    await reconcileEventStatuses(ctx, now);
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should issue neither Update nor Query when READY and endsAt is absent (open-ended event)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-OPEN",
          tenantId: "tenant-acme",
          eventId: "EV-OPEN",
          status: "READY",
        },
      ],
    });

    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });
});
