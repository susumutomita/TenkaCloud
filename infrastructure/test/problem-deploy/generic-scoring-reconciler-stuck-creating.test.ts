import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStuckCreatingForDeploy,
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
  rescueStuckCreatingDeployments,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx } from "./generic-scoring-reconciler.test-helpers";

describe("reconcileEventStatuses stuck-create recovery (#2651)", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof import("vitest").vi.fn>;

  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });

  afterEach(() => ddbSend.mockReset());

  it("should fail stale PENDING and IN_PROGRESS rows and unlock DEPLOYING in the same tick", async () => {
    const now = "2026-07-15T02:00:00.000Z";
    const stale = "2026-07-15T00:50:00.000Z";
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-STUCK-CREATE",
          tenantId: "tenant-acme",
          eventId: "EV-STUCK-CREATE",
          status: "DEPLOYING",
        },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#COMPLETE", status: "COMPLETE", updatedAt: now },
        { PK: "DEPLOYMENT#PENDING", status: "PENDING", updatedAt: stale },
        { PK: "DEPLOYMENT#IN-PROGRESS", status: "IN_PROGRESS", updatedAt: stale },
      ],
    });
    ddbSend.mockResolvedValue({});

    await reconcileEventStatuses(ctx, now);

    expect(ddbSend).toHaveBeenCalledTimes(5);
    const updateInputs = ddbSend.mock.calls
      .slice(2)
      .map((call) => (call[0] as { input: Record<string, unknown> }).input);
    const rescueInputs = updateInputs.filter(
      (input) => input.ConditionExpression === "#status IN (:pending, :inProgress)",
    );
    expect(rescueInputs).toHaveLength(2);
    expect(rescueInputs.map((input) => input.Key)).toEqual(
      expect.arrayContaining([
        { PK: "DEPLOYMENT#PENDING", SK: "META" },
        { PK: "DEPLOYMENT#IN-PROGRESS", SK: "META" },
      ]),
    );
    expect(
      updateInputs.some(
        (input) =>
          (input.ExpressionAttributeValues as Record<string, string> | undefined)?.[":next"] ===
          "READY",
      ),
    ).toBe(true);
  });

  it("should leave a recent PENDING row alone while the state machine can still complete", async () => {
    const now = "2026-07-15T02:00:00.000Z";
    const recent = "2026-07-15T01:30:00.000Z";
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-ACTIVE-CREATE",
          tenantId: "tenant-acme",
          eventId: "EV-ACTIVE-CREATE",
          status: "DEPLOYING",
        },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "DEPLOYMENT#ACTIVE", status: "PENDING", updatedAt: recent }],
    });

    await reconcileEventStatuses(ctx, now);

    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("should not advance the event when the conditional rescue loses a completion race", async () => {
    const now = "2026-07-15T02:00:00.000Z";
    const stale = "2026-07-15T00:50:00.000Z";
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EV-RACE",
          tenantId: "tenant-acme",
          eventId: "EV-RACE",
          status: "DEPLOYING",
        },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "DEPLOYMENT#RACE", status: "IN_PROGRESS", updatedAt: stale }],
    });
    ddbSend.mockImplementationOnce(async () => {
      const error: Error & { name?: string } = new Error("conditional check failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    });

    await expect(reconcileEventStatuses(ctx, now)).resolves.toBeUndefined();

    expect(ddbSend).toHaveBeenCalledTimes(3);
  });

  it("should classify only stale create states under a DEPLOYING event", () => {
    const nowMs = Date.parse("2026-07-15T02:00:00.000Z");
    const stale = "2026-07-15T00:50:00.000Z";
    const recent = "2026-07-15T01:30:00.000Z";
    expect(
      isStuckCreatingForDeploy("DEPLOYING", { status: "PENDING", updatedAt: stale }, nowMs),
    ).toBe(true);
    expect(
      isStuckCreatingForDeploy("DEPLOYING", { status: "IN_PROGRESS", updatedAt: stale }, nowMs),
    ).toBe(true);
    expect(isStuckCreatingForDeploy("READY", { status: "PENDING", updatedAt: stale }, nowMs)).toBe(
      false,
    );
    expect(
      isStuckCreatingForDeploy("DEPLOYING", { status: "COMPLETE", updatedAt: stale }, nowMs),
    ).toBe(false);
    expect(
      isStuckCreatingForDeploy("DEPLOYING", { status: "PENDING", updatedAt: recent }, nowMs),
    ).toBe(false);
    expect(isStuckCreatingForDeploy("DEPLOYING", { status: "PENDING" }, nowMs)).toBe(false);
  });

  it("should skip a projected row without jobId instead of writing an ambiguous key", async () => {
    const rescued = await rescueStuckCreatingDeployments(
      ctx,
      [{ status: "PENDING", updatedAt: "2026-07-15T00:50:00.000Z" }],
      Date.parse("2026-07-15T02:00:00.000Z"),
    );
    expect(rescued).toBe(0);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
