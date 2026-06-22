import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx, NOW_ISO } from "./generic-scoring-reconciler.test-helpers";

/**
 * #557 / #539 / #1038: end-to-end transition scenarios for the reconciler.
 *
 * Covers the happy paths that issue a DDB Update:
 *   - DEPLOYING → READY (all child deployments COMPLETE)
 *   - TEARDOWN → ARCHIVED (all child deployments DELETED)
 *   - READY → ENDED (endsAt past now; skips deployment Query)
 *   - PENDING child blocks READY transition
 *   - Multiple Events processed in parallel
 *   - Scan FilterExpression scoping (don't touch ENDED / ARCHIVED)
 *
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

describe("reconcileEventStatuses transitions (#557 #539 #1038)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof import("vitest").vi.fn>;
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

  it("Event filter should target DEPLOYING / READY / TEARDOWN + ENDED (ADR-047 teardown) and project teardownAt", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await reconcileEventStatuses(ctx, NOW_ISO);
    const scanCmd = ddbSend.mock.calls[0]?.[0] as {
      input: {
        ProjectionExpression: string;
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    // ADR-047: ENDED も拾う (teardownAt 経過の自動撤去対象)。 ARCHIVED は対象外のまま。
    expect(scanCmd.input.FilterExpression).toBe(
      "#status = :deploying OR #status = :ready OR #status = :teardown OR #status = :ended",
    );
    expect(scanCmd.input.ExpressionAttributeValues[":deploying"]).toBe("DEPLOYING");
    expect(scanCmd.input.ExpressionAttributeValues[":ready"]).toBe("READY");
    expect(scanCmd.input.ExpressionAttributeValues[":teardown"]).toBe("TEARDOWN");
    expect(scanCmd.input.ExpressionAttributeValues[":ended"]).toBe("ENDED");
    // Issue #1038 P0 #3: READY → ENDED 判定に endsAt が要るので projection に含める
    expect(scanCmd.input.ProjectionExpression).toContain("endsAt");
    // ADR-047: 自動撤去判定に teardownAt / teardownFiredAt を projection に含める
    expect(scanCmd.input.ProjectionExpression).toContain("teardownAt");
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
