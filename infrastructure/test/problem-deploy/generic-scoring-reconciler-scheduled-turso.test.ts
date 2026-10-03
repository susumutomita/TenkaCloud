import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const teardown = vi.hoisted(() => ({ bulkTeardownEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-delete", () => teardown);

import type {
  EventRecord,
  EventsRepository,
} from "../../lib/problem-deploy/control-data/events-repository";
import type { ControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories";
import { buildScheduledTeardownResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";

/**
 * Issue #2739 integration pin: once the Turso-aware builder returns resources,
 * the existing reconciler must enter the same bulk-teardown path as DynamoDB.
 */

const NOW_ISO = "2026-07-21T12:30:00.000Z";
const DUE_EVENT: EventRecord = {
  eventId: "01KY29N716HRCNDJ7VBMAQQ3ZG",
  tenantId: "tenant-acme",
  name: "Turso scheduled teardown",
  status: "READY",
  problems: [],
  teamCount: 0,
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T10:00:00.000Z",
  expiresAt: 1_800_000_000,
  teardownAt: "2026-07-21T12:23:00.000Z",
};

const ENV_KEYS = [
  "CONTROL_DATA_BACKEND",
  "COMPETITOR_ACCOUNTS_TABLE_NAME",
  "EVENTS_TABLE_NAME",
  "DEPLOYMENTS_TABLE_NAME",
  "TEAMS_TABLE_NAME",
  "DEPLOY_EVENT_BUS_NAME",
  "DEPLOY_ENVIRONMENT",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CONTROL_DATA_BACKEND = "turso";
  process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
  process.env.DEPLOY_ENVIRONMENT = "development";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("reconcileEventStatuses scheduled Turso teardown (#2739)", () => {
  it("should enter bulkTeardownEvent for a due Turso event without table-name env variables", async () => {
    const listEventsByStatus = vi.fn(async () => [DUE_EVENT]);
    const markScheduleFired = vi.fn(async () => ({ outcome: "updated" as const }));
    const eventsRepository = {
      listEventsByStatus,
      markScheduleFired,
    } as unknown as EventsRepository;
    const resolveEventsRepository = vi.fn(async () => eventsRepository);
    const runtime = {
      needsManualPrune: () => false,
      resolveEventsRepository,
    } as unknown as ControlDataRuntime;

    const teardownDeps = buildScheduledTeardownResources(runtime);
    expect(teardownDeps).toBeDefined();
    if (!teardownDeps) throw new Error("Turso teardown resources should be enabled");

    teardown.bulkTeardownEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: DUE_EVENT.eventId, enqueued: 1, skipped: 0, failed: 0 },
    });
    const ctx: ReconcileEventStatusesContext = {
      runtime,
      ddb: teardownDeps.ddb,
      eventsTableName: teardownDeps.eventsTableName,
      deploymentsTableName: teardownDeps.deploymentsTableName,
      teardownDeps,
    };

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(listEventsByStatus).toHaveBeenCalledWith([
      "DEPLOYING",
      "READY",
      "TEARDOWN",
      "ENDED",
      "DRAFT",
    ]);
    expect(teardown.bulkTeardownEvent).toHaveBeenCalledTimes(1);
    expect(teardown.bulkTeardownEvent).toHaveBeenCalledWith(
      teardownDeps,
      DUE_EVENT.tenantId,
      DUE_EVENT.eventId,
      Date.parse(NOW_ISO),
    );
    expect(markScheduleFired).toHaveBeenCalledWith(
      DUE_EVENT.tenantId,
      DUE_EVENT.eventId,
      "teardown",
      NOW_ISO,
    );
  });
});
