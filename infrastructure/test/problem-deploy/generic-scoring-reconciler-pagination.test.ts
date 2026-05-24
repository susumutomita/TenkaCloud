import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx, NOW_ISO } from "./generic-scoring-reconciler.test-helpers";

/**
 * #557 / #539: pagination scenarios for the reconciler.
 *
 * Covers DDB Scan + Query pagination via `LastEvaluatedKey`. The reconciler
 * must follow cursors for both the events Scan and the deployments-per-event
 * Query so that judging READY does not race with a paginated tail.
 *
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

describe("reconcileEventStatuses pagination (#557 #539)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof import("vitest").vi.fn>;
  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });
  afterEach(() => ddbSend.mockReset());

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
});
