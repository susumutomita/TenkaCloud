import { type DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbDeploymentsRepository } from "../../../lib/problem-deploy/control-data/deployments-repository";
import type {
  DeploymentRecord,
  InboxEventRecord,
  ScoreEventRecord,
} from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb } from "./control-data-write.test-helpers";

/**
 * [Issue #2441 / Phase B3] Deployment Scan + sub-aggregate-write seam source map:
 * - generic-scoring-handler/index.ts:146-198 -> forEachCompleteDeploymentPage
 * - generic-scoring-handler/composite-status-reconciler.ts:126-143 -> forEachCompositeDeployReconcilablePage
 * - generic-scoring-handler/composite-teardown-reconciler.ts:130-147 -> forEachCompositeTeardownPendingPage
 * - generic-scoring-handler/runtime-status-reconciler.ts:167-186 -> forEachRuntimeReconcilablePage
 * - handlers/shared/score-event.ts (`writeScoreEvent`, retired in B3) -> appendScoreEvent
 * - participant-handler/cast-event.ts:170-183 (pre-B3) -> appendInboxEvent
 * - participant-handler/coordination-store.ts:63-77 (pre-B3) -> writeCoordinationState
 */

const TABLE = "Deployments";
// biome-ignore lint/suspicious/noExplicitAny: raw DDB item fixtures.
type Item = Record<string, any>;

/** A full META `DeploymentItem` row (base PK/SK only — no GSI keys needed for Scans). */
function metaItem(over: Item = {}): Item {
  const base = {
    jobId: "j1",
    tenantId: "tenant-a",
    problemId: "p1",
    status: "COMPLETE",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4_102_444_800,
  };
  const m = { ...base, ...over };
  return { PK: `DEPLOYMENT#${m.jobId}`, SK: "META", ...m };
}

/** Fake DocumentClient that records the Commands it receives (for byte-pin). */
function recording(pageSize?: number): {
  ddb: DynamoDBDocumentClient;
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands.
  commands: any[];
  seed: (items: Item[]) => Promise<void>;
  reset: () => void;
} {
  const ddb = makeFakeDdb(pageSize === undefined ? {} : { pageSize });
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands.
  const commands: any[] = [];
  const original = ddb.send.bind(ddb);
  // biome-ignore lint/suspicious/noExplicitAny: wrap the fake send.
  (ddb as any).send = (cmd: any) => {
    commands.push(cmd);
    return original(cmd);
  };
  return {
    ddb,
    commands,
    seed: async (items) => {
      for (const item of items) await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    },
    reset: () => {
      commands.length = 0;
    },
  };
}

function makeRepo(pageSize?: number) {
  const ctx = recording(pageSize);
  return { repo: new DynamoDbDeploymentsRepository(ctx.ddb, TABLE), ...ctx };
}

/** Drains a per-page callback method into `{ pages, all }` for easy assertions. */
async function drain<T>(
  run: (onPage: (items: readonly T[]) => Promise<void>) => Promise<void>,
): Promise<{ pages: T[][]; all: T[] }> {
  const pages: T[][] = [];
  await run(async (items) => {
    pages.push([...items]);
  });
  return { pages, all: pages.flat() };
}

describe("DynamoDbDeploymentsRepository — Scan (per-page callback)", () => {
  describe("forEachCompleteDeploymentPage", () => {
    it("should return only COMPLETE rows across the whole table when eventId is omitted", async () => {
      const { repo, seed, commands, reset } = makeRepo();
      await seed([
        metaItem({ jobId: "a", status: "COMPLETE" }),
        metaItem({ jobId: "b", status: "PENDING" }),
        metaItem({ jobId: "c", status: "COMPLETE", eventId: "ev-2" }),
      ]);
      reset();

      const { all } = await drain<DeploymentRecord>((onPage) =>
        repo.forEachCompleteDeploymentPage(onPage),
      );
      expect(all.map((r) => r.jobId).sort()).toEqual(["a", "c"]);

      const scan = commands[0].input;
      expect(scan.FilterExpression).toBe("#status = :complete");
      expect(scan.ExpressionAttributeNames).toEqual({ "#status": "status" });
      expect(scan.ExpressionAttributeValues).toEqual({ ":complete": "COMPLETE" });
      expect(scan.Limit).toBe(200);
      expect(scan.IndexName).toBeUndefined();
      expect(scan.ProjectionExpression).toBeUndefined();
    });

    it("should invoke onPage once per physical Scan page (multi-page drain, not a single collected batch)", async () => {
      const { repo, seed } = makeRepo(2); // force 2 rows per page, capped below Limit=200
      await seed(
        ["a", "b", "c", "d", "e"].map((id) => metaItem({ jobId: id, status: "COMPLETE" })),
      );

      const { pages, all } = await drain<DeploymentRecord>((onPage) =>
        repo.forEachCompleteDeploymentPage(onPage),
      );
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.every((p) => p.length <= 2)).toBe(true);
      expect(all.map((r) => r.jobId).sort()).toEqual(["a", "b", "c", "d", "e"]);
    });
  });

  describe("forEachCompositeDeployReconcilablePage", () => {
    it("should return only composite parents in PENDING/IN_PROGRESS", async () => {
      const { repo, seed, commands, reset } = makeRepo();
      await seed([
        metaItem({ jobId: "a", runtimeKind: "composite", status: "PENDING" }),
        metaItem({ jobId: "b", runtimeKind: "composite", status: "IN_PROGRESS" }),
        metaItem({ jobId: "c", runtimeKind: "composite", status: "DELETING" }),
        metaItem({ jobId: "d", runtimeKind: "composite", status: "COMPLETE" }),
        metaItem({ jobId: "legacy", status: "PENDING" }), // no runtimeKind — legacy single-provider
      ]);
      reset();

      const { all } = await drain<DeploymentRecord>((onPage) =>
        repo.forEachCompositeDeployReconcilablePage(onPage),
      );
      expect(all.map((r) => r.jobId).sort()).toEqual(["a", "b"]);

      const scan = commands[0].input;
      expect(scan.FilterExpression).toBe("runtimeKind = :composite AND #s IN (:p, :i)");
      expect(scan.ExpressionAttributeNames).toEqual({ "#s": "status" });
      expect(scan.ExpressionAttributeValues).toEqual({
        ":composite": "composite",
        ":p": "PENDING",
        ":i": "IN_PROGRESS",
      });
      expect(scan.Limit).toBe(200);
    });
  });

  describe("forEachCompositeTeardownPendingPage", () => {
    it("should return only composite parents currently DELETING", async () => {
      const { repo, seed, commands, reset } = makeRepo();
      await seed([
        metaItem({ jobId: "a", runtimeKind: "composite", status: "DELETING" }),
        metaItem({ jobId: "b", runtimeKind: "composite", status: "PENDING" }),
        metaItem({ jobId: "c", status: "DELETING" }), // not composite
      ]);
      reset();

      const { all } = await drain<DeploymentRecord>((onPage) =>
        repo.forEachCompositeTeardownPendingPage(onPage),
      );
      expect(all.map((r) => r.jobId)).toEqual(["a"]);

      const scan = commands[0].input;
      expect(scan.FilterExpression).toBe("runtimeKind = :composite AND #s = :deleting");
      expect(scan.ExpressionAttributeNames).toEqual({ "#s": "status" });
      expect(scan.ExpressionAttributeValues).toEqual({
        ":composite": "composite",
        ":deleting": "DELETING",
      });
      expect(scan.Limit).toBe(200);
    });
  });

  describe("forEachRuntimeReconcilablePage", () => {
    it("should return only active non-AWS runtime rows (terminal / AWS rows excluded)", async () => {
      const { repo, seed, commands, reset } = makeRepo();
      await seed([
        metaItem({ jobId: "a", runtimeProvider: "sakura", status: "PENDING" }),
        metaItem({ jobId: "b", runtimeProvider: "sakura", status: "DELETED" }), // terminal, excluded
        metaItem({ jobId: "c", status: "PENDING" }), // no runtimeProvider (AWS)
      ]);
      reset();

      const { all } = await drain<DeploymentRecord>((onPage) =>
        repo.forEachRuntimeReconcilablePage(onPage),
      );
      expect(all.map((r) => r.jobId)).toEqual(["a"]);

      const scan = commands[0].input;
      expect(scan.FilterExpression).toBe(
        "attribute_exists(runtimeProvider) AND #s IN (:p, :i, :c, :d)",
      );
      expect(scan.ExpressionAttributeNames).toEqual({ "#s": "status" });
      expect(scan.ExpressionAttributeValues).toEqual({
        ":p": "PENDING",
        ":i": "IN_PROGRESS",
        ":c": "COMPLETE",
        ":d": "DELETING",
      });
      expect(scan.Limit).toBe(200);
    });
  });
});

describe("DynamoDbDeploymentsRepository — sub-aggregate writes (Phase B3)", () => {
  describe("appendScoreEvent", () => {
    it("should append a score-event row readable via listScoreEvents (round-trip + byte-pin)", async () => {
      const { repo, commands, reset } = makeRepo();
      reset();
      const record: ScoreEventRecord = {
        jobId: "j1",
        problemId: "p1",
        teamId: "t1",
        eventId: "ev-1",
        source: "uptime",
        points: 10,
        result: "ok",
        occurredAt: "2026-06-01T00:00:00.000Z",
        expiresAt: 4_102_444_800,
      };
      await repo.appendScoreEvent(record);

      const put = commands.find((c) => c instanceof PutCommand);
      expect(put).toBeDefined();
      expect(put.input.TableName).toBe(TABLE);
      expect(put.input.Item.PK).toBe("DEPLOYMENT#j1");
      expect(put.input.Item.SK).toMatch(/^EVENT#2026-06-01T00:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);

      const rows = await repo.listScoreEvents("j1", { pageSize: 10 });
      expect(rows).toEqual([record]);
    });
  });

  describe("appendInboxEvent", () => {
    it("should append an inbox row on the TARGET partition, readable via listInboxEventsInRange (round-trip + byte-pin)", async () => {
      const { repo, commands, reset } = makeRepo();
      reset();
      const record: InboxEventRecord = {
        eventId: "ev-1",
        fromTeamId: "team-2",
        fromJobId: "sender-1",
        kind: "sabotage",
        payload: { amount: 1 },
        occurredAt: "2026-06-05T00:00:00.000Z",
        ttl: 4_102_444_800,
      };
      await repo.appendInboxEvent("target-1", "01INBOXIDXXXXXXXXXXXXXXXXX", record);

      const put = commands.find((c) => c instanceof PutCommand);
      expect(put).toBeDefined();
      expect(put.input.TableName).toBe(TABLE);
      expect(put.input.Item).toEqual({
        PK: "DEPLOYMENT#target-1",
        SK: "INBOX#2026-06-05T00:00:00.000Z#01INBOXIDXXXXXXXXXXXXXXXXX",
        ...record,
      });

      const rows = await repo.listInboxEventsInRange(
        "target-1",
        "INBOX#2026-06-01T00:00:00.000Z",
        "INBOX#~",
      );
      expect(rows).toEqual([record]);
    });
  });

  describe("writeCoordinationState (optimistic lock)", () => {
    /** [Issue #3123] see deployments-repository.test.ts's coordScope. */
    const coordScope = (tenantId: string, eventId: string, problemId = "problem-a") => ({
      tenantId,
      eventId,
      problemId,
      runId: "default",
    });

    it("should create the row on the first write (version 0 -> 1)", async () => {
      const { repo, commands, reset } = makeRepo();
      reset();
      const outcome = await repo.writeCoordinationState(
        coordScope("tn1", "ev-1"),
        { turns: 1 },
        0,
        "2026-06-01T00:00:00.000Z",
        0,
      );
      expect(outcome).toEqual({ outcome: "updated" });

      const put = commands.find((c) => c instanceof PutCommand);
      expect(put.input.ConditionExpression).toBe(
        "attribute_not_exists(version) OR version = :expected",
      );
      expect(put.input.ExpressionAttributeValues).toEqual({ ":expected": 0 });
      expect(await repo.readCoordinationState(coordScope("tn1", "ev-1"))).toEqual({
        state: { turns: 1 },
        version: 1,
      });
    });

    it("should update on a matching version and bump it (the `updated` branch)", async () => {
      const { repo } = makeRepo();
      await repo.writeCoordinationState(
        coordScope("tn1", "ev-1"),
        { turns: 1 },
        0,
        "2026-06-01T00:00:00.000Z",
        0,
      );
      const outcome = await repo.writeCoordinationState(
        coordScope("tn1", "ev-1"),
        { turns: 2 },
        1,
        "2026-06-01T00:01:00.000Z",
        0,
      );
      expect(outcome).toEqual({ outcome: "updated" });
      expect(await repo.readCoordinationState(coordScope("tn1", "ev-1"))).toEqual({
        state: { turns: 2 },
        version: 2,
      });
    });

    it("should return conflict on a version mismatch without mutating the row (the `conflict` branch)", async () => {
      const { repo } = makeRepo();
      await repo.writeCoordinationState(
        coordScope("tn1", "ev-1"),
        { turns: 1 },
        0,
        "2026-06-01T00:00:00.000Z",
        0,
      );
      const outcome = await repo.writeCoordinationState(
        coordScope("tn1", "ev-1"),
        { turns: 99 },
        0, // stale expected version — the row is already at version 1
        "2026-06-01T00:02:00.000Z",
        0,
      );
      expect(outcome).toEqual({ outcome: "conflict" });
      expect(await repo.readCoordinationState(coordScope("tn1", "ev-1"))).toEqual({
        state: { turns: 1 },
        version: 1,
      });
    });
  });
});
