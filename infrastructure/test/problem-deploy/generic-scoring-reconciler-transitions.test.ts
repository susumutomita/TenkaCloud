import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { buildCtx, NOW_ISO } from "./generic-scoring-reconciler.test-helpers";

type EventsRepository = Awaited<ReturnType<ControlDataRuntime["resolveEventsRepository"]>>;
type TeamsRepository = Awaited<ReturnType<ControlDataRuntime["resolveTeamsRepository"]>>;
type NotificationsRepository = Awaited<
  ReturnType<ControlDataRuntime["resolveNotificationsRepository"]>
>;
type DisruptionsRepository = Awaited<
  ReturnType<ControlDataRuntime["resolveDisruptionsRepository"]>
>;
type AdminAuditLogRepository = Awaited<
  ReturnType<ControlDataRuntime["resolveAdminAuditLogRepository"]>
>;
type DeploymentsRepository = Awaited<
  ReturnType<ControlDataRuntime["resolveDeploymentsRepository"]>
>;

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
  afterEach(() => {
    vi.restoreAllMocks();
    ddbSend.mockReset();
  });

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

  it("Event filter should target DEPLOYING / READY / TEARDOWN + ENDED + DRAFT", async () => {
    // [#2438 / Phase A3] The raw Scan moved into the `listEventsByStatus` repository
    // seam (`dynamodb-events-repository.ts`), which generates its own `:s0, :s1, …`
    // placeholder names and always projects the full row (EventRecord shape) — so
    // this test now pins the *status set* passed to the seam, not literal DDB
    // expression-attribute names (that shape is covered by the repository's own
    // parity tests). ARCHIVED must stay excluded.
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await reconcileEventStatuses(ctx, NOW_ISO);
    const scanCmd = ddbSend.mock.calls[0]?.[0] as {
      input: {
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    const filteredStatuses = new Set(Object.values(scanCmd.input.ExpressionAttributeValues));
    expect(filteredStatuses).toEqual(new Set(["DEPLOYING", "READY", "TEARDOWN", "ENDED", "DRAFT"]));
    expect(filteredStatuses.has("ARCHIVED")).toBe(false);
  });

  it("should prune all expiring pure-SQL control-data aggregates before status reconciliation", async () => {
    const nowEpochSeconds = Math.floor(Date.parse(NOW_ISO) / 1000);
    const pruneEvents = {
      pruneExpired: vi.fn(async () => 1),
    } as unknown as EventsRepository;
    const listEvents = {
      listEventsByStatus: vi.fn(async () => []),
    } as unknown as EventsRepository;
    const pruneTeams = {
      pruneExpired: vi.fn(async () => 2),
    } as unknown as TeamsRepository;
    const pruneNotifications = {
      pruneExpired: vi.fn(async () => 3),
    } as unknown as NotificationsRepository;
    const pruneDisruptions = {
      pruneExpired: vi.fn(async () => 4),
    } as unknown as DisruptionsRepository;
    const pruneAdminAuditLog = {
      pruneExpired: vi.fn(async () => 5),
    } as unknown as AdminAuditLogRepository;
    const pruneDeployments = {
      sweepExpiredCoordinationState: vi.fn(async () => 6),
    } as unknown as DeploymentsRepository;
    vi.spyOn(ctx.runtime, "needsManualPrune").mockReturnValue(true);
    vi.spyOn(ctx.runtime, "resolveEventsRepository").mockImplementation(async (input) =>
      input.eventsTableName ? listEvents : pruneEvents,
    );
    vi.spyOn(ctx.runtime, "resolveTeamsRepository").mockResolvedValue(pruneTeams);
    vi.spyOn(ctx.runtime, "resolveNotificationsRepository").mockResolvedValue(pruneNotifications);
    vi.spyOn(ctx.runtime, "resolveDisruptionsRepository").mockResolvedValue(pruneDisruptions);
    // [Issue #2442 / Phase C4] AdminAuditLog joins the manual-prune tick alongside Disruptions.
    vi.spyOn(ctx.runtime, "resolveAdminAuditLogRepository").mockResolvedValue(pruneAdminAuditLog);
    // [Issue #3127] Coordination was the aggregate this tick missed. Its sweep is
    // spelled `sweepExpiredCoordinationState` on the deployments port rather than
    // `pruneExpired`, which is how it was overlooked when the tick was wired.
    vi.spyOn(ctx.runtime, "resolveDeploymentsRepository").mockResolvedValue(pruneDeployments);

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(pruneEvents.pruneExpired).toHaveBeenCalledWith(nowEpochSeconds);
    expect(pruneTeams.pruneExpired).toHaveBeenCalledWith(nowEpochSeconds);
    expect(pruneNotifications.pruneExpired).toHaveBeenCalledWith(nowEpochSeconds);
    expect(pruneDisruptions.pruneExpired).toHaveBeenCalledWith(nowEpochSeconds);
    expect(pruneAdminAuditLog.pruneExpired).toHaveBeenCalledWith(nowEpochSeconds);
    expect(pruneDeployments.sweepExpiredCoordinationState).toHaveBeenCalledWith(nowEpochSeconds);
    expect(listEvents.listEventsByStatus).toHaveBeenCalledWith([
      "DEPLOYING",
      "READY",
      "TEARDOWN",
      "ENDED",
      "DRAFT",
    ]);
  });

  it("should not resolve Teams or Notifications prune repositories when manual prune is disabled", async () => {
    vi.spyOn(ctx.runtime, "needsManualPrune").mockReturnValue(false);
    const teamsSpy = vi.spyOn(ctx.runtime, "resolveTeamsRepository");
    const notificationsSpy = vi.spyOn(ctx.runtime, "resolveNotificationsRepository");
    // [Issue #3127] DynamoDB reaps `expiresAt` natively, so the coordination
    // sweep must stay off the tick there — otherwise every reconcile pass would
    // pay for a full-table Scan that deletes rows the table already deletes.
    const deploymentsSpy = vi.spyOn(ctx.runtime, "resolveDeploymentsRepository");
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(teamsSpy).not.toHaveBeenCalled();
    expect(notificationsSpy).not.toHaveBeenCalled();
    expect(deploymentsSpy).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should warn and continue the status tick when manual prune fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pruneEvents = {
      pruneExpired: vi.fn(async () => {
        throw new Error("temporary SQL outage");
      }),
    } as unknown as EventsRepository;
    const listEvents = {
      listEventsByStatus: vi.fn(async () => []),
    } as unknown as EventsRepository;
    vi.spyOn(ctx.runtime, "needsManualPrune").mockReturnValue(true);
    vi.spyOn(ctx.runtime, "resolveEventsRepository").mockImplementation(async (input) =>
      input.eventsTableName ? listEvents : pruneEvents,
    );
    vi.spyOn(ctx.runtime, "resolveTeamsRepository").mockResolvedValue({
      pruneExpired: vi.fn(async () => 0),
    } as unknown as TeamsRepository);
    vi.spyOn(ctx.runtime, "resolveNotificationsRepository").mockResolvedValue({
      pruneExpired: vi.fn(async () => 0),
    } as unknown as NotificationsRepository);
    vi.spyOn(ctx.runtime, "resolveDisruptionsRepository").mockResolvedValue({
      pruneExpired: vi.fn(async () => 0),
    } as unknown as DisruptionsRepository);
    // [Issue #2442 / Phase C4] AdminAuditLog also joins the resolution Promise.all — must be
    // mocked or the real (unmocked) resolver throws first (missing ddb/adminAuditLogTableName
    // under the default dynamodb backend), masking the "temporary SQL outage" assertion below.
    vi.spyOn(ctx.runtime, "resolveAdminAuditLogRepository").mockResolvedValue({
      pruneExpired: vi.fn(async () => 0),
    } as unknown as AdminAuditLogRepository);
    // [Issue #3127] Same reason for Deployments (the coordination sweep).
    vi.spyOn(ctx.runtime, "resolveDeploymentsRepository").mockResolvedValue({
      sweepExpiredCoordinationState: vi.fn(async () => 0),
    } as unknown as DeploymentsRepository);

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] manual prune failed",
      expect.objectContaining({ message: "temporary SQL outage" }),
    );
    expect(listEvents.listEventsByStatus).toHaveBeenCalled();
  });

  it("should NOT query child deployments for a DRAFT event that is not deploy-due (dormant / no deployDeps)", async () => {
    // DRAFT で deployAt 無し → 早期 return (= Scan 1 回のみ、 deployment Query を発行しない)。
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#DR1", tenantId: "tenant-acme", eventId: "DR1", status: "DRAFT" }],
    });
    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(ddbSend).toHaveBeenCalledTimes(1);
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

  it("should skip a malformed event row missing tenantId/eventId/status (defensive guard)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "EVENT#BAD", tenantId: "tenant-acme", status: "DEPLOYING" }], // no eventId
    });

    await reconcileEventStatuses(ctx, NOW_ISO);
    // Scan only — the malformed row returns early before any Query/Update.
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });
});
