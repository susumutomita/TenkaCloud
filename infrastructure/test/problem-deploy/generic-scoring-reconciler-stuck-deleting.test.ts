import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStuckDeletingForTeardown,
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
  rescueStuckDeletingDeployments,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx } from "./generic-scoring-reconciler.test-helpers";

/**
 * #828: stuck-DELETING rescue path for the reconciler.
 *
 * Covers the rescue path that demotes long-stuck (`DELETING` for 30+ min) child
 * deployments to FAILED so the parent event can finish TEARDOWN → ARCHIVED,
 * plus the pure `isStuckDeletingForTeardown` predicate and the
 * `rescueStuckDeletingDeployments` projection-leak / CCF guards.
 *
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

describe("reconcileEventStatuses stuck-DELETING rescue (#828)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof import("vitest").vi.fn>;
  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });
  afterEach(() => ddbSend.mockReset());

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
});
