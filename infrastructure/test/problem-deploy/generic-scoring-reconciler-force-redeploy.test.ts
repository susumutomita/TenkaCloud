import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository";
import {
  DynamoDbEventsRepository,
  type EventRecord,
  type EventsRepository,
  SqlEventsRepository,
} from "../../lib/problem-deploy/control-data/events-repository";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/types";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #3261: a force redeploy must not let the reconciler release READY from
 * a stale view of the event's deployments.
 *
 * A force redeploy deletes deployment A (COMPLETE), writes its replacement B
 * (PENDING) and then moves the event to DEPLOYING. On DynamoDB the reconciler
 * reads deployments through the eventually consistent GSI1, which can still
 * return only A. Two guards are pinned here on real repositories (fake DDB /
 * in-memory SQLite):
 *   - every GSI1 candidate is re-read from its base row with a strongly
 *     consistent read before READY;
 *   - the READY CAS pins the event's `updatedAt`, so a redeploy landing between
 *     the reads and the CAS (status is DEPLOYING again) makes the CAS lose.
 */

const TENANT = "tenant-acme";
const EVENT_ID = "01EVENTFORCEREDEPLOYAAAAAA";
const DEPLOYMENTS_TABLE = "Deployments";
const EVENTS_TABLE = "Events";
const FIRST_DEPLOY_AT = "2026-09-01T00:00:00.000Z";
const REDEPLOY_AT = "2026-09-01T01:00:00.000Z";
const NOW_ISO = "2026-09-01T01:01:00.000Z";

type Backend = "DynamoDB" | "Turso";

function eventRecord(status: EventRecord["status"], updatedAt: string): EventRecord {
  const record: EventRecord = {
    eventId: EVENT_ID,
    tenantId: TENANT,
    name: "Force redeploy cup",
    status,
    problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: FIRST_DEPLOY_AT,
    updatedAt,
    expiresAt: 4102444800,
  };
  return record;
}

function deployment(
  jobId: string,
  teamId: string,
  status: DeploymentRecord["status"],
  at: string,
): DeploymentRecord {
  return {
    tenantId: TENANT,
    eventId: EVENT_ID,
    problemId: "p1",
    jobId,
    teamId,
    teamName: teamId,
    teamLoginKey: `login-${teamId}`,
    namePrefix: `${teamId}-p1`,
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    status,
    createdAt: at,
    updatedAt: at,
  };
}

interface Harness {
  readonly ctx: ReconcileEventStatusesContext;
  readonly events: EventsRepository;
  readonly deployments: DynamoDbDeploymentsRepository | SqlDeploymentsRepository;
  /** Repository over the lagging GSI1 view (DynamoDB only; SQL has no index lag). */
  readonly indexView?: DynamoDbDeploymentsRepository;
  /** Makes the GSI1 view identical to the base table again (index caught up). */
  readonly catchUpIndex: () => void;
  /** Runs `hook` once, inside the reconciler's first base-row confirmation read. */
  readonly onFirstConfirmationRead: (hook: () => Promise<void>) => void;
}

/**
 * DynamoDB: `primary` is the base table; GSI1 Queries on the Deployments table
 * are answered by `index`, a second fake that only changes when a test writes to
 * it or calls `catchUpIndex` — a lagging projection.
 */
function makeHarness(backend: Backend): Harness {
  let hook: (() => Promise<void>) | undefined;
  const runHookOnce = async () => {
    const pending = hook;
    hook = undefined;
    if (pending) await pending();
  };

  if (backend === "DynamoDB") {
    const primary = makeFakeDdb();
    let index = makeFakeDdb();
    let indexLags = true;
    const ddb = {
      send: async (cmd: {
        constructor: { name: string };
        input: { TableName?: string; IndexName?: string; ConsistentRead?: boolean };
      }) => {
        if (
          cmd.constructor.name === "QueryCommand" &&
          cmd.input.TableName === DEPLOYMENTS_TABLE &&
          cmd.input.IndexName === "GSI1" &&
          indexLags
        ) {
          return index.send(cmd as never);
        }
        if (
          cmd.constructor.name === "GetCommand" &&
          cmd.input.TableName === DEPLOYMENTS_TABLE &&
          cmd.input.ConsistentRead === true
        ) {
          await runHookOnce();
        }
        return primary.send(cmd as never);
      },
    } as unknown as DynamoDBDocumentClient;
    const events = new DynamoDbEventsRepository(ddb, EVENTS_TABLE);
    const deployments = new DynamoDbDeploymentsRepository(ddb, DEPLOYMENTS_TABLE);
    const indexView = new DynamoDbDeploymentsRepository(index, DEPLOYMENTS_TABLE);
    const runtime = {
      ...makeTestControlDataRuntime(),
      needsManualPrune: () => false,
      resolveEventsRepository: async () => events,
      resolveDeploymentsRepository: async () => deployments,
    };
    return {
      ctx: {
        runtime,
        ddb,
        eventsTableName: EVENTS_TABLE,
        deploymentsTableName: DEPLOYMENTS_TABLE,
      } as unknown as ReconcileEventStatusesContext,
      events,
      deployments,
      indexView,
      catchUpIndex: () => {
        indexLags = false;
        index = primary;
      },
      onFirstConfirmationRead: (next) => {
        hook = next;
      },
    };
  }

  const sql = makeSqliteExecutor();
  const events = new SqlEventsRepository(sql);
  const base = new SqlDeploymentsRepository(sql);
  // The SQL backend has no index to lag; the race hook wraps the repository read.
  const deployments = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "getDeployment") {
        return async (...args: Parameters<SqlDeploymentsRepository["getDeployment"]>) => {
          await runHookOnce();
          return target.getDeployment(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const runtime = {
    ...makeTestControlDataRuntime({ CONTROL_DATA_BACKEND: "turso" }),
    needsManualPrune: () => false,
    resolveEventsRepository: async () => events,
    resolveDeploymentsRepository: async () => deployments,
  };
  // The SQL backend must never reach DynamoDB; fail loudly if it does.
  const noDdb: Pick<DynamoDBDocumentClient, "send"> = {
    send: () => Promise.reject(new Error("DynamoDB must not be used by the Turso backend")),
  };
  return {
    ctx: {
      runtime,
      ddb: noDdb,
      eventsTableName: EVENTS_TABLE,
      deploymentsTableName: DEPLOYMENTS_TABLE,
    } as unknown as ReconcileEventStatusesContext,
    events,
    deployments,
    catchUpIndex: () => undefined,
    onFirstConfirmationRead: (next) => {
      hook = next;
    },
  };
}

/**
 * The bulk-deploy order: write rows (Put + Delete of the replaced row), then DEPLOYING.
 * Without `batch` the event is marked the way it was before `deployBatch`
 * existed (a legacy row), so these cases exercise the base-row confirmation alone.
 */
async function forceRedeploy(
  harness: Pick<Harness, "events" | "deployments">,
  replacement: DeploymentRecord,
  replacesJobId: string | undefined,
  batch?: { readonly count: number },
): Promise<void> {
  const outcome = await harness.deployments.createBulkDeployments(TENANT, [
    { record: replacement, ...(replacesJobId ? { replacesJobId } : {}) },
  ]);
  expect(outcome.outcome).toBe("updated");
  const marked = await harness.events.markDeploying(TENANT, EVENT_ID, REDEPLOY_AT, batch);
  expect(marked.outcome).toBe("updated");
}

/**
 * An additive bulk deploy as the orchestrator runs it: Put every new row (no
 * `replacesJobId`, nothing deleted), then mark DEPLOYING with the batch that
 * counts every row written. Every row carries the batch's `createdAt`.
 */
async function additiveBulkDeploy(
  harness: Pick<Harness, "events" | "deployments">,
  records: readonly DeploymentRecord[],
): Promise<void> {
  for (const record of records) expect(record.createdAt).toBe(REDEPLOY_AT);
  const outcome = await harness.deployments.createBulkDeployments(
    TENANT,
    records.map((record) => ({ record })),
  );
  expect(outcome.outcome).toBe("updated");
  const marked = await harness.events.markDeploying(TENANT, EVENT_ID, REDEPLOY_AT, {
    count: records.length,
  });
  expect(marked.outcome).toBe("updated");
}

/** A batch row after its deploy finished: same `createdAt`, later `updatedAt`. */
function finished(record: DeploymentRecord, status: DeploymentRecord["status"]): DeploymentRecord {
  return { ...record, status, updatedAt: NOW_ISO };
}

/** Swaps the deployments repository the reconciler resolves, keeping everything else. */
function withDeploymentsRepository(
  harness: Harness,
  repository: Harness["deployments"],
): ReconcileEventStatusesContext {
  const base = harness.ctx as unknown as { runtime: Record<string, unknown> };
  return {
    ...base,
    runtime: { ...base.runtime, resolveDeploymentsRepository: async () => repository },
  } as unknown as ReconcileEventStatusesContext;
}

async function eventStatus(events: EventsRepository): Promise<string | undefined> {
  return (await events.getEvent(TENANT, EVENT_ID, true))?.status;
}

describe("reconcileEventStatuses force redeploy vs stale GSI1 (#3261)", () => {
  it("should keep DEPLOYING when GSI1 still returns only the deleted COMPLETE row", async () => {
    const harness = makeHarness("DynamoDB");
    const { events, deployments, indexView } = harness;
    if (!indexView) throw new Error("DynamoDB harness must expose the index view");
    await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
    const old = deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT);
    await deployments.putDeployment(old);
    await indexView.putDeployment(old);

    // Base table: A deleted, B PENDING, event DEPLOYING. GSI1: still only A=COMPLETE.
    await forceRedeploy(harness, deployment("JOB-B", "team-1", "PENDING", REDEPLOY_AT), "JOB-A");
    expect(await indexView.listReconcilerRowsByEvent(TENANT, EVENT_ID)).toEqual([
      expect.objectContaining({ jobId: "JOB-A", status: "COMPLETE" }),
    ]);

    await reconcileEventStatuses(harness.ctx, NOW_ISO);

    expect(await eventStatus(events)).toBe("DEPLOYING");
    const stored = await events.getEvent(TENANT, EVENT_ID, true);
    expect(stored?.updatedAt).toBe(REDEPLOY_AT);
  });

  it("should keep DEPLOYING when a stale COMPLETE index row's base row is now IN_PROGRESS", async () => {
    const harness = makeHarness("DynamoDB");
    const { events, deployments, indexView } = harness;
    if (!indexView) throw new Error("DynamoDB harness must expose the index view");
    await events.putEvent(eventRecord("DEPLOYING", REDEPLOY_AT));
    await deployments.putDeployment(deployment("JOB-B", "team-1", "IN_PROGRESS", REDEPLOY_AT));
    await indexView.putDeployment(deployment("JOB-B", "team-1", "COMPLETE", REDEPLOY_AT));

    await reconcileEventStatuses(harness.ctx, NOW_ISO);

    expect(await eventStatus(events)).toBe("DEPLOYING");
  });

  it("should release READY on a later tick once the replacement is terminal and the index caught up", async () => {
    const harness = makeHarness("DynamoDB");
    const { events, deployments, indexView } = harness;
    if (!indexView) throw new Error("DynamoDB harness must expose the index view");
    await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
    const old = deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT);
    await deployments.putDeployment(old);
    await indexView.putDeployment(old);
    await forceRedeploy(harness, deployment("JOB-B", "team-1", "PENDING", REDEPLOY_AT), "JOB-A");

    await reconcileEventStatuses(harness.ctx, NOW_ISO);
    expect(await eventStatus(events)).toBe("DEPLOYING");

    await deployments.putDeployment(deployment("JOB-B", "team-1", "COMPLETE", NOW_ISO));
    harness.catchUpIndex();
    await reconcileEventStatuses(harness.ctx, NOW_ISO);

    expect(await eventStatus(events)).toBe("READY");
  });

  describe("additive bulk deploy vs lagging GSI1 (deploy batch marker)", () => {
    it("should keep DEPLOYING while GSI1 has not surfaced the new batch row, then release READY", async () => {
      const harness = makeHarness("DynamoDB");
      const { events, deployments, indexView } = harness;
      if (!indexView) throw new Error("DynamoDB harness must expose the index view");
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      const old = deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT);
      await deployments.putDeployment(old);
      await indexView.putDeployment(old);

      // Base table: A COMPLETE + B PENDING, event DEPLOYING with batch {REDEPLOY_AT, 1}.
      // GSI1 has not surfaced B: it still lists only A, and A's base row is COMPLETE.
      const added = deployment("JOB-B", "team-2", "PENDING", REDEPLOY_AT);
      await additiveBulkDeploy(harness, [added]);
      expect(await indexView.listReconcilerRowsByEvent(TENANT, EVENT_ID)).toEqual([
        expect.objectContaining({ jobId: "JOB-A", status: "COMPLETE", createdAt: FIRST_DEPLOY_AT }),
      ]);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      let logged: unknown[][];
      try {
        await reconcileEventStatuses(harness.ctx, NOW_ISO);
      } finally {
        logged = [...log.mock.calls];
        log.mockRestore();
      }

      const deferred = await events.getEvent(TENANT, EVENT_ID, true);
      expect(deferred?.status).toBe("DEPLOYING");
      expect(deferred?.deployBatch).toEqual({ createdAt: REDEPLOY_AT, count: 1 });
      expect(logged).toContainEqual([
        "[generic-scoring] READY deferred: deploy batch not fully listed yet",
        { eventId: EVENT_ID, expected: 1, visible: 0 },
      ]);

      await deployments.putDeployment(finished(added, "COMPLETE"));
      harness.catchUpIndex();
      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      expect(await eventStatus(events)).toBe("READY");
    });

    it("should keep DEPLOYING while GSI1 lists only one of the batch's two rows, even when it is COMPLETE", async () => {
      const harness = makeHarness("DynamoDB");
      const { events, deployments, indexView } = harness;
      if (!indexView) throw new Error("DynamoDB harness must expose the index view");
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      const old = deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT);
      await deployments.putDeployment(old);
      await indexView.putDeployment(old);

      const first = deployment("JOB-B", "team-2", "PENDING", REDEPLOY_AT);
      const second = deployment("JOB-C", "team-3", "PENDING", REDEPLOY_AT);
      await additiveBulkDeploy(harness, [first, second]);
      // B finished and GSI1 surfaced it; C is still PENDING and not yet in GSI1.
      await deployments.putDeployment(finished(first, "COMPLETE"));
      await indexView.putDeployment(finished(first, "COMPLETE"));

      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      expect(await eventStatus(events)).toBe("DEPLOYING");

      await deployments.putDeployment(finished(second, "FAILED"));
      harness.catchUpIndex();
      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      expect(await eventStatus(events)).toBe("READY");
    });
  });

  describe.each<Backend>(["DynamoDB", "Turso"])("%s backend", (backend) => {
    it("should still reach READY when a later batch replaced rows of the batch but failed before marking DEPLOYING", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      const added = [
        deployment("JOB-B", "team-1", "PENDING", REDEPLOY_AT),
        deployment("JOB-C", "team-2", "PENDING", REDEPLOY_AT),
      ];
      await additiveBulkDeploy(harness, added);
      // A later force batch replaced JOB-B with JOB-D and then failed before its
      // markDeploying: the event still records the earlier batch of 2.
      const replaced = await deployments.createBulkDeployments(TENANT, [
        { record: deployment("JOB-D", "team-1", "COMPLETE", NOW_ISO), replacesJobId: "JOB-B" },
      ]);
      expect(replaced.outcome).toBe("updated");
      await deployments.putDeployment(finished(added[1] as DeploymentRecord, "COMPLETE"));

      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      expect(await eventStatus(events)).toBe("READY");
    });

    it("should not count a listed row without createdAt toward the batch", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      const added = deployment("JOB-B", "team-1", "PENDING", REDEPLOY_AT);
      await additiveBulkDeploy(harness, [added]);
      await deployments.putDeployment(finished(added, "COMPLETE"));
      const withoutCreatedAt = new Proxy(deployments, {
        get(target, prop, receiver) {
          if (prop === "listReconcilerRowsByEvent") {
            return async (tenantId: string, eventId: string) =>
              (await target.listReconcilerRowsByEvent(tenantId, eventId)).map(
                ({ createdAt: _omitted, ...row }) => row,
              );
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      await reconcileEventStatuses(withDeploymentsRepository(harness, withoutCreatedAt), NOW_ISO);

      expect(await eventStatus(events)).toBe("DEPLOYING");
    });

    it("should move an additive deploy to READY once every row of the batch is terminal", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT));
      const added = [
        deployment("JOB-B", "team-2", "PENDING", REDEPLOY_AT),
        deployment("JOB-C", "team-3", "PENDING", REDEPLOY_AT),
      ];
      await additiveBulkDeploy(harness, added);

      await reconcileEventStatuses(harness.ctx, NOW_ISO);
      expect(await eventStatus(events)).toBe("DEPLOYING");

      await deployments.putDeployment(finished(added[0] as DeploymentRecord, "COMPLETE"));
      await deployments.putDeployment(finished(added[1] as DeploymentRecord, "FAILED"));
      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      const stored = await events.getEvent(TENANT, EVENT_ID, true);
      expect(stored?.status).toBe("READY");
      expect(stored?.updatedAt).toBe(NOW_ISO);
    });

    it.each<["eventId" | "tenantId", string]>([
      ["eventId", "01EVENTSOMEOTHEREVENTAAAAA"],
      ["tenantId", "tenant-other"],
    ])("should keep DEPLOYING when a base row now carries another %s", async (field, value) => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("DEPLOYING", REDEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", REDEPLOY_AT));
      // The listed row is terminal, but its base row no longer belongs to this event.
      const reassigned = new Proxy(deployments, {
        get(target, prop, receiver) {
          if (prop === "getDeployment") {
            return async (...args: Parameters<SqlDeploymentsRepository["getDeployment"]>) => {
              const current = await target.getDeployment(...args);
              return current ? { ...current, [field]: value } : current;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await reconcileEventStatuses(withDeploymentsRepository(harness, reassigned), NOW_ISO);
        expect(log).toHaveBeenCalledWith(
          "[generic-scoring] READY deferred: index rows not confirmed by base rows",
          { eventId: EVENT_ID, unconfirmed: 1 },
        );
      } finally {
        log.mockRestore();
      }

      expect(await eventStatus(events)).toBe("DEPLOYING");
    });

    it.each<DeploymentRecord["status"]>([
      "PENDING",
      "IN_PROGRESS",
    ])("should keep DEPLOYING while an old COMPLETE row sits next to a new %s row", async (status) => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("READY", FIRST_DEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT));
      await forceRedeploy(harness, deployment("JOB-B", "team-2", status, REDEPLOY_AT), undefined);

      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      expect(await eventStatus(events)).toBe("DEPLOYING");
    });

    it("should lose the READY CAS when a redeploy lands between the reads and the CAS", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      // The first deploy is finished: DEPLOYING with a single COMPLETE row.
      await events.putEvent(eventRecord("DEPLOYING", FIRST_DEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", FIRST_DEPLOY_AT));
      // While the reconciler is confirming A, a redeploy adds B and re-marks DEPLOYING
      // (status unchanged, updatedAt moved).
      harness.onFirstConfirmationRead(() =>
        forceRedeploy(harness, deployment("JOB-B", "team-2", "PENDING", REDEPLOY_AT), undefined),
      );

      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      const stored = await events.getEvent(TENANT, EVENT_ID, true);
      expect(stored?.status).toBe("DEPLOYING");
      expect(stored?.updatedAt).toBe(REDEPLOY_AT);
    });

    it("should still move DEPLOYING to READY when every current deployment is terminal", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("DEPLOYING", REDEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", REDEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-B", "team-2", "FAILED", REDEPLOY_AT));

      await reconcileEventStatuses(harness.ctx, NOW_ISO);

      const stored = await events.getEvent(TENANT, EVENT_ID, true);
      expect(stored?.status).toBe("READY");
      expect(stored?.updatedAt).toBe(NOW_ISO);
    });

    it.each<[string, unknown, string]>([
      ["an Error", new Error("throttled"), "throttled"],
      ["a non-Error value", "connection reset", "connection reset"],
    ])("should keep DEPLOYING and report it when the base-row read throws %s", async (_label, thrown, message) => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("DEPLOYING", REDEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", REDEPLOY_AT));
      harness.onFirstConfirmationRead(() => Promise.reject(thrown));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        await reconcileEventStatuses(harness.ctx, NOW_ISO);
        expect(warn).toHaveBeenCalledWith("[generic-scoring] READY confirmation read failed", {
          eventId: EVENT_ID,
          message,
        });
      } finally {
        warn.mockRestore();
      }

      expect(await eventStatus(events)).toBe("DEPLOYING");
    });

    it("should keep DEPLOYING when an index row carries no jobId to confirm", async () => {
      const harness = makeHarness(backend);
      harness.catchUpIndex();
      const { events, deployments } = harness;
      await events.putEvent(eventRecord("DEPLOYING", REDEPLOY_AT));
      await deployments.putDeployment(deployment("JOB-A", "team-1", "COMPLETE", REDEPLOY_AT));
      // A terminal index row without a jobId cannot be checked against a base row.
      const withoutJobId = new Proxy(deployments, {
        get(target, prop, receiver) {
          if (prop === "listReconcilerRowsByEvent") {
            return async (tenantId: string, eventId: string) => [
              ...(await target.listReconcilerRowsByEvent(tenantId, eventId)),
              { jobId: "", status: "COMPLETE", updatedAt: REDEPLOY_AT },
            ];
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      await reconcileEventStatuses(withDeploymentsRepository(harness, withoutJobId), NOW_ISO);

      expect(await eventStatus(events)).toBe("DEPLOYING");
    });
  });
});
