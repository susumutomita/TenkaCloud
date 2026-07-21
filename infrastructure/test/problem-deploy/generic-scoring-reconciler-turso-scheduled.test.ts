import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Issue #2739] Regression test for the 2026-07-21 live incident: on a pure-Turso Lite
 * deploy (`CONTROL_DATA_BACKEND=turso`), scheduled auto-teardown/deploy never fired because
 * `buildScheduledTeardownResources` / `buildScheduledDeployResources` treated the *absent*
 * table-name env (expected on turso — those tables are never synthesized) as "not wired yet"
 * and returned `undefined` forever, so `reconcileEventStatuses` always saw `teardownDeps` /
 * `deployDeps` as `undefined` and skipped the scheduled action every tick.
 *
 * This suite wires `reconcileEventStatuses` with `teardownDeps` / `deployDeps` built by the
 * REAL `buildScheduledTeardownResources` / `buildScheduledDeployResources` under a turso env
 * that deliberately omits every table-name env (mirroring the pure-SQL synth shape), and
 * asserts the reconciler actually reaches `bulkTeardownEvent` / `bulkDeployEvent` instead of
 * silently staying dormant. `bulkTeardownEvent` / `bulkDeployEvent` themselves are module-mocked
 * (their turso-readiness is covered by their own repository-seam suites) — this test's job is
 * only to pin that the builders no longer gate on tables that pure SQL never provisions.
 */

const teardown = vi.hoisted(() => ({ bulkTeardownEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-delete", () => teardown);

const deploy = vi.hoisted(() => ({ bulkDeployEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-deploy", () => deploy);

import {
  buildScheduledDeployResources,
  buildScheduledTeardownResources,
} from "../../lib/problem-deploy/handlers/event-handler/shared";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_ISO = "2026-05-11T00:00:00.000Z";
const PAST = "2026-05-10T23:00:00.000Z";

const TURSO_TEARDOWN_ENV = {
  CONTROL_DATA_BACKEND: "turso",
  DEPLOY_EVENT_BUS_NAME: "bus",
  DEPLOY_ENVIRONMENT: "development",
} as const;

const TURSO_DEPLOY_ENV = {
  ...TURSO_TEARDOWN_ENV,
  BATTLE_PROBLEMS_CATALOG: JSON.stringify({ "hello-world-battle": "battle/hello-world-battle" }),
} as const;

const ENV_KEYS = [
  ...new Set([...Object.keys(TURSO_TEARDOWN_ENV), ...Object.keys(TURSO_DEPLOY_ENV)]),
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  teardown.bulkTeardownEvent.mockReset();
  deploy.bulkDeployEvent.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function buildCtx(over: Partial<ReconcileEventStatusesContext> = {}): {
  ctx: ReconcileEventStatusesContext;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  // The outer scan (listEventsByStatus) is unaffected by this bug — it already defaults its
  // table names to "" regardless of backend — so a plain dynamodb-backend test runtime wrapping
  // a fake `ddb` is enough here; only teardownDeps/deployDeps need the real turso-env builders.
  const ddbSend = vi.fn();
  const ctx: ReconcileEventStatusesContext = {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: ddbSend } as unknown as ReconcileEventStatusesContext["ddb"],
    eventsTableName: "TestEvents",
    deploymentsTableName: "TestDeployments",
    ...over,
  };
  return { ctx, ddbSend };
}

describe("reconcileEventStatuses on pure-Turso (Issue #2739 regression)", () => {
  it("should fire bulkTeardownEvent when teardownDeps is built from a turso env with no table names wired", async () => {
    for (const [key, value] of Object.entries(TURSO_TEARDOWN_ENV)) process.env[key] = value;
    const teardownDeps = buildScheduledTeardownResources(makeTestControlDataRuntime());
    // Before the fix this was `undefined` forever on turso — the core bug.
    expect(teardownDeps).toBeDefined();

    const { ctx, ddbSend } = buildCtx({ teardownDeps });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVT",
          tenantId: "tenant-acme",
          eventId: "EVT",
          status: "READY",
          teardownAt: PAST,
        },
      ],
    });
    teardown.bulkTeardownEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: "EVT", enqueued: 2, skipped: 0, failed: 0 },
    });
    ddbSend.mockResolvedValueOnce({}); // recordFired (teardownFiredAt) Update

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(teardown.bulkTeardownEvent).toHaveBeenCalledTimes(1);
    expect(teardown.bulkTeardownEvent).toHaveBeenCalledWith(
      teardownDeps,
      "tenant-acme",
      "EVT",
      Date.parse(NOW_ISO),
    );
  });

  it("should fire bulkDeployEvent when deployDeps is built from a turso env with no table names wired", async () => {
    for (const [key, value] of Object.entries(TURSO_DEPLOY_ENV)) process.env[key] = value;
    const deployDeps = buildScheduledDeployResources(makeTestControlDataRuntime());
    // Before the fix this was `undefined` forever on turso — the deploy-side mirror of the bug.
    expect(deployDeps).toBeDefined();

    const { ctx, ddbSend } = buildCtx({ deployDeps });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: "EVD", enqueued: 4, skipped: 0 },
    });
    ddbSend.mockResolvedValueOnce({}); // recordFired (deployFiredAt) Update

    await reconcileEventStatuses(ctx, NOW_ISO);

    expect(deploy.bulkDeployEvent).toHaveBeenCalledTimes(1);
    expect(deploy.bulkDeployEvent).toHaveBeenCalledWith(
      deployDeps,
      "tenant-acme",
      "EVD",
      Date.parse(NOW_ISO),
    );
  });
});
