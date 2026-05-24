import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
  rescueStuckDeletingDeployments,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx, NOW_ISO } from "./generic-scoring-reconciler.test-helpers";

/**
 * #557 / #828: ConditionalCheckFailedException (CCF) silent-skip behavior.
 *
 * The reconciler races against operator-driven `EndEvent` / `MarkDeleted` /
 * `MarkFailed` writers. When the operator wins the race the reconciler must
 * silently swallow the CCF and move on — it must not throw and surface a
 * non-actionable error to CloudWatch.
 *
 * Split out from `generic-scoring-reconciler.test.ts` per #1255.
 */

describe("reconcileEventStatuses CCF skip (#557 #828)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof import("vitest").vi.fn>;
  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });
  afterEach(() => ddbSend.mockReset());

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
});
