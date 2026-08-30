import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentsRepository,
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2441 / Phase B1] DynamoDB byte-pin test suite for the Deployments READ
 * seam. The SQL parity suite lives in `deployments-repository-parity.test.ts`;
 * this file keeps pinning the DynamoDB backend two ways:
 *   1. Round-trip: seed raw rows through the in-memory fake DocumentClient, read
 *      through the repository, assert the returned domain records.
 *   2. Byte-pin: record the Command that reaches the fake and assert the exact
 *      KeyCondition / Filter / Projection / placeholder / Limit / ScanIndexForward
 *      is a verbatim relocation of the named pre-seam handler site.
 * Plus a multi-page drain contract (the `ddb-paginate` absorption regression).
 */

const TABLE = "Deployments";
const KEY_ATTRS = ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK", "GSI3PK", "GSI3SK"];

// biome-ignore lint/suspicious/noExplicitAny: raw DDB item fixtures.
type Item = Record<string, any>;

function stripped(item: Item): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) {
    if (KEY_ATTRS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** A full META `DeploymentItem` row with its physical keys derived. */
function metaItem(over: Item = {}): Item {
  const base = {
    jobId: "01JOBAAAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    problemId: "p1",
    awsAccountId: "123456789012",
    region: "us-east-1",
    teamName: "team-a",
    namePrefix: "np-a",
    status: "COMPLETE",
    teamLoginKey: "KEY-A",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800,
  };
  const m = { ...base, ...over };
  const item: Item = {
    PK: `DEPLOYMENT#${m.jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${m.tenantId}`,
    GSI1SK: m.createdAt,
    ...m,
  };
  if (m.teamLoginKey) {
    item.GSI2PK = `TEAMKEY#${m.teamLoginKey}`;
    item.GSI2SK = m.createdAt;
  }
  return item;
}

/** A composite target row (base META + GSI3 keys, `deploy-handler` shape). */
function targetItem(parentId: string, ordinal: number, over: Item = {}): Item {
  const item = metaItem({ teamLoginKey: "", ...over });
  delete item.GSI2PK;
  delete item.GSI2SK;
  item.GSI3PK = `PARENT_DEPLOYMENT#${parentId}`;
  item.GSI3SK = `ORDINAL#${String(ordinal).padStart(4, "0")}#TARGET#${over.jobId ?? item.jobId}`;
  item.parentDeploymentId = parentId;
  return item;
}

/** An `EVENT#` score-event row in a deployment's partition. */
function scoreEventItem(jobId: string, sk: string, over: Item = {}): Item {
  return {
    PK: `DEPLOYMENT#${jobId}`,
    SK: sk,
    jobId,
    problemId: "p1",
    teamId: "team-1",
    eventId: "ev-1",
    source: "uptime",
    points: 10,
    result: "ok",
    occurredAt: sk.slice("EVENT#".length).split("#")[0],
    expiresAt: 4102444800,
    ...over,
  };
}

/** An `INBOX#` inter-team cast row in a deployment's partition. */
function inboxItem(jobId: string, sk: string, over: Item = {}): Item {
  return {
    PK: `DEPLOYMENT#${jobId}`,
    SK: sk,
    eventId: "ev-1",
    fromTeamId: "team-2",
    fromJobId: "01FROMJOB",
    kind: "sabotage",
    payload: { amount: 1 },
    occurredAt: sk.slice("INBOX#".length).split("#")[0],
    ttl: 4102444800,
    ...over,
  };
}

/**
 * [Issue #3123] A coordination scope. Every port call names all four
 * dimensions; there is no default that would silently rejoin a shared
 * namespace.
 */
function coordScope(tenantId: string, eventId: string, problemId = "problem-a", runId = "default") {
  return { tenantId, eventId, problemId, runId };
}

/** A `COORD#` coordination-state row. */
function coordItem(
  tenantId: string,
  eventId: string,
  over: Item = {},
  problemId = "problem-a",
  runId = "default",
): Item {
  return {
    PK: `COORD#${tenantId}#${eventId}#${problemId}#${runId}`,
    SK: "STATE",
    state: { flags: 3 },
    version: 2,
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
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

// biome-ignore lint/suspicious/noExplicitAny: read one Command's input.
const queries = (commands: any[]) => commands.filter((c) => c instanceof QueryCommand);

describe("DynamoDbDeploymentsRepository — point reads", () => {
  it("should get a META row by jobId via GetItem (verbatim key)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    const item = metaItem({ jobId: "j1" });
    await seed([item]);
    reset();

    const record = await repo.getDeployment("j1");

    expect(record).toEqual(stripped(item));
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands[0].input.Key).toEqual({ PK: "DEPLOYMENT#j1", SK: "META" });
  });

  it("should return undefined for a missing deployment (getDeployment)", async () => {
    const { repo } = makeRepo();
    expect(await repo.getDeployment("nope")).toBeUndefined();
  });

  it("should NOT apply a tenant filter in getDeployment (raw read, caller guards)", async () => {
    const { repo, seed } = makeRepo();
    await seed([metaItem({ jobId: "j1", tenantId: "tenant-x" })]);
    // No tenant argument exists — the row comes back regardless (404-fold stays
    // in the caller, matching the pre-seam handlers).
    expect((await repo.getDeployment("j1"))?.tenantId).toBe("tenant-x");
  });

  it("should read the META row via Query for queryDeploymentMeta (verbatim expr)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    const item = metaItem({ jobId: "j1" });
    await seed([item]);
    reset();

    const record = await repo.queryDeploymentMeta("j1");

    expect(record).toEqual(stripped(item));
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk AND SK = :sk");
    expect(commands[0].input.ExpressionAttributeValues).toEqual({
      ":pk": "DEPLOYMENT#j1",
      ":sk": "META",
    });
    expect(commands[0].input.IndexName).toBeUndefined();
  });

  it("should return undefined for a missing deployment (queryDeploymentMeta)", async () => {
    const { repo } = makeRepo();
    expect(await repo.queryDeploymentMeta("nope")).toBeUndefined();
  });
});

describe("DynamoDbDeploymentsRepository — GSI1 tenant reads", () => {
  it("should page a tenant listing newest-first with an opaque cursor", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", createdAt: "2026-06-01T00:00:00.000Z", teamLoginKey: "" }),
      metaItem({ jobId: "b", createdAt: "2026-06-02T00:00:00.000Z", teamLoginKey: "" }),
      metaItem({ jobId: "c", createdAt: "2026-06-03T00:00:00.000Z", teamLoginKey: "" }),
    ]);
    reset();

    const page1 = await repo.listByTenantPage("tenant-a", { limit: 2 });
    expect(page1.items.map((r) => r.jobId)).toEqual(["c", "b"]); // newest-first
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listByTenantPage("tenant-a", { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.jobId)).toEqual(["a"]);
    expect(page2.nextCursor).toBeUndefined();

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI1");
    expect(first.KeyConditionExpression).toBe("GSI1PK = :pk");
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#tenant-a" });
    expect(first.ScanIndexForward).toBe(false);
    expect(first.Limit).toBe(2);
  });

  it("should count active deployments with a status IN filter and Select COUNT", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", status: "PENDING", teamLoginKey: "" }),
      metaItem({ jobId: "b", status: "IN_PROGRESS", teamLoginKey: "" }),
      metaItem({ jobId: "c", status: "COMPLETE", teamLoginKey: "" }),
      metaItem({ jobId: "d", status: "DELETED", teamLoginKey: "" }),
    ]);
    reset();

    const count = await repo.countActiveByTenant("tenant-a", [
      "PENDING",
      "IN_PROGRESS",
      "COMPLETE",
    ]);
    expect(count).toBe(3);

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI1");
    expect(first.FilterExpression).toBe("#s IN (:s0, :s1, :s2)");
    expect(first.ExpressionAttributeNames).toEqual({ "#s": "status" });
    expect(first.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#tenant-a",
      ":s0": "PENDING",
      ":s1": "IN_PROGRESS",
      ":s2": "COMPLETE",
    });
    expect(first.Select).toBe("COUNT");
  });

  it("should stop paging the count early once stopAtCount is reached", async () => {
    const { repo, seed, commands, reset } = makeRepo(2); // 2 rows per page
    await seed(
      ["a", "b", "c", "d", "e"].map((id, i) =>
        metaItem({
          jobId: id,
          createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
          status: "PENDING",
          teamLoginKey: "",
        }),
      ),
    );
    reset();

    const count = await repo.countActiveByTenant("tenant-a", ["PENDING"], { stopAtCount: 3 });
    // Broke after the 2nd page (4 >= 3), never read the 3rd page.
    expect(count).toBe(4);
    expect(queries(commands)).toHaveLength(2);
  });

  it("should list every deployment for a (tenant, event) pair", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", eventId: "ev-1", teamLoginKey: "" }),
      metaItem({ jobId: "b", eventId: "ev-2", teamLoginKey: "" }),
      metaItem({ jobId: "c", eventId: "ev-1", teamLoginKey: "" }),
    ]);
    reset();

    const rows = await repo.listByTenantAndEvent("tenant-a", "ev-1");
    expect(rows.map((r) => r.jobId).sort()).toEqual(["a", "c"]);

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI1");
    expect(first.FilterExpression).toBe("eventId = :ev");
    expect(first.ProjectionExpression).toBeUndefined();
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#tenant-a", ":ev": "ev-1" });
  });

  it("should drain every page of a (tenant, event) listing", async () => {
    const { repo, seed } = makeRepo(2); // force 2 rows per page
    await seed(
      ["a", "b", "c", "d", "e"].map((id, i) =>
        metaItem({
          jobId: id,
          createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
          eventId: "ev-1",
          teamLoginKey: "",
        }),
      ),
    );
    const rows = await repo.listByTenantAndEvent("tenant-a", "ev-1");
    expect(rows.map((r) => r.jobId).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("should list only jobIds for a (tenant, event) via a PK projection", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", eventId: "ev-1", teamLoginKey: "" }),
      metaItem({ jobId: "b", eventId: "ev-1", teamLoginKey: "" }),
    ]);
    reset();

    const ids = await repo.listDeploymentKeysByEvent("tenant-a", "ev-1");
    expect([...ids].sort()).toEqual(["a", "b"]);

    expect(commands[0].input.ProjectionExpression).toBe("PK");
    expect(commands[0].input.FilterExpression).toBe("eventId = :ev");
  });

  it("should list reconciler rows (jobId/status/updatedAt) with the reserved-word projection", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({
        jobId: "a",
        eventId: "ev-1",
        status: "DELETING",
        updatedAt: "2026-06-05T00:00:00.000Z",
        teamLoginKey: "",
      }),
    ]);
    reset();

    const rows = await repo.listReconcilerRowsByEvent("tenant-a", "ev-1");
    expect(rows).toEqual([
      { jobId: "a", status: "DELETING", updatedAt: "2026-06-05T00:00:00.000Z" },
    ]);

    const first = commands[0].input;
    expect(first.ProjectionExpression).toBe("PK, #status, updatedAt");
    expect(first.ExpressionAttributeNames).toEqual({ "#status": "status" });
    expect(first.FilterExpression).toBe("eventId = :ev");
  });

  it("should resolve deployments by (event, team, problem) with a triple filter", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", eventId: "ev-1", teamId: "t1", problemId: "p1", teamLoginKey: "" }),
      metaItem({ jobId: "b", eventId: "ev-1", teamId: "t2", problemId: "p1", teamLoginKey: "" }),
    ]);
    reset();

    const rows = await repo.listByEventTeamProblem("tenant-a", "ev-1", "t1", "p1");
    expect(rows.map((r) => r.jobId)).toEqual(["a"]);

    const first = commands[0].input;
    expect(first.FilterExpression).toBe("eventId = :ev AND teamId = :tid AND problemId = :pid");
    expect(first.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#tenant-a",
      ":ev": "ev-1",
      ":tid": "t1",
      ":pid": "p1",
    });
  });

  it("should find non-terminal rows by namePrefix with the classify projection", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", namePrefix: "shared", status: "COMPLETE", teamLoginKey: "" }),
      metaItem({ jobId: "b", namePrefix: "other", status: "COMPLETE", teamLoginKey: "" }),
    ]);
    reset();

    const rows = await repo.findByNamePrefix("tenant-a", "shared");
    expect(rows).toEqual([{ namePrefix: "shared", jobId: "a", status: "COMPLETE" }]);

    const first = commands[0].input;
    expect(first.FilterExpression).toBe("namePrefix = :np");
    expect(first.ProjectionExpression).toBe("namePrefix, jobId, #s");
    expect(first.ExpressionAttributeNames).toEqual({ "#s": "status" });
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#tenant-a", ":np": "shared" });
  });

  it("should list per-event detail summaries in a single page (no filter, no drain)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({
        jobId: "a",
        teamId: "t1",
        eventId: "ev-1",
        displayTeamName: "Alpha",
        teamName: "slug-a",
        problemId: "p1",
        status: "COMPLETE",
        teamLoginKey: "",
      }),
    ]);
    reset();

    const rows = await repo.listDeploymentSummariesByTenant("tenant-a");
    expect(rows).toEqual([
      {
        jobId: "a",
        teamId: "t1",
        eventId: "ev-1",
        displayTeamName: "Alpha",
        teamName: "slug-a",
        problemId: "p1",
        status: "COMPLETE",
      },
    ]);

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI1");
    expect(first.FilterExpression).toBeUndefined();
    expect(first.ProjectionExpression).toBe(
      "PK, teamId, eventId, displayTeamName, teamName, problemId, jobId, #s",
    );
    expect(first.ExpressionAttributeNames).toEqual({ "#s": "status" });
    expect(queries(commands)).toHaveLength(1); // single Query, no drain
  });
});

describe("DynamoDbDeploymentsRepository — GSI2 / GSI3", () => {
  it("should look up a team's rows by login key (GSI2)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "a", teamLoginKey: "SHARED" }),
      metaItem({ jobId: "b", teamLoginKey: "OTHER" }),
    ]);
    reset();

    const rows = await repo.listByTeamLoginKey("SHARED");
    expect(rows.map((r) => r.jobId)).toEqual(["a"]);

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI2");
    expect(first.KeyConditionExpression).toBe("GSI2PK = :pk");
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "TEAMKEY#SHARED" });
  });

  it("should list a composite parent's targets in ordinal order (GSI3)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      targetItem("parent-1", 2, { jobId: "t2" }),
      targetItem("parent-1", 1, { jobId: "t1" }),
      targetItem("parent-2", 1, { jobId: "x1" }),
    ]);
    reset();

    const rows = await repo.listCompositeTargets("parent-1");
    expect(rows.map((r) => r.jobId)).toEqual(["t1", "t2"]); // GSI3SK ascending

    const first = commands[0].input;
    expect(first.IndexName).toBe("GSI3");
    expect(first.KeyConditionExpression).toBe("GSI3PK = :pk");
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "PARENT_DEPLOYMENT#parent-1" });
    expect(first.ScanIndexForward).toBe(true);
  });
});

describe("DynamoDbDeploymentsRepository — sparse sub-aggregates", () => {
  it("should list score events newest-first with begins_with(EVENT#) + pageSize", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      metaItem({ jobId: "j1", teamLoginKey: "" }),
      scoreEventItem("j1", "EVENT#2026-06-01T00:00:00.000Z#a"),
      scoreEventItem("j1", "EVENT#2026-06-02T00:00:00.000Z#b"),
    ]);
    reset();

    const rows = await repo.listScoreEvents("j1", { pageSize: 100 });
    expect(rows.map((r) => r.occurredAt)).toEqual([
      "2026-06-02T00:00:00.000Z", // ScanIndexForward=false → descending
      "2026-06-01T00:00:00.000Z",
    ]);

    const first = commands[0].input;
    expect(first.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :evpfx)");
    expect(first.ExpressionAttributeValues).toEqual({ ":pk": "DEPLOYMENT#j1", ":evpfx": "EVENT#" });
    expect(first.ScanIndexForward).toBe(false);
    expect(first.Limit).toBe(100);
  });

  it("should drain all bounded pages of score events when under maxPages", async () => {
    const { repo, seed } = makeRepo();
    await seed(
      ["a", "b", "c", "d", "e"].map((id) =>
        scoreEventItem("j1", `EVENT#2026-06-01T00:00:0${id.charCodeAt(0) - 96}.000Z#${id}`),
      ),
    );
    const rows = await repo.listScoreEvents("j1", { pageSize: 2, maxPages: 10 });
    expect(rows).toHaveLength(5);
  });

  it("should stop score-event paging at maxPages (bounded drain)", async () => {
    const { repo, seed } = makeRepo();
    await seed(
      ["a", "b", "c", "d", "e", "f"].map((id) =>
        scoreEventItem("j1", `EVENT#2026-06-01T00:00:0${id.charCodeAt(0) - 96}.000Z#${id}`),
      ),
    );
    // pageSize 2 × maxPages 2 = 4 rows read, even though 6 exist.
    const rows = await repo.listScoreEvents("j1", { pageSize: 2, maxPages: 2 });
    expect(rows).toHaveLength(4);
  });

  it("should list score events over an SK range (BETWEEN)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      scoreEventItem("j1", "EVENT#2026-06-01T00:00:00.000Z#a"),
      scoreEventItem("j1", "EVENT#2026-06-05T00:00:00.000Z#b"),
    ]);
    reset();

    const rows = await repo.listScoreEventsInRange(
      "j1",
      "EVENT#2026-06-02T00:00:00.000Z",
      "EVENT#~",
    );
    expect(rows.map((r) => r.occurredAt)).toEqual(["2026-06-05T00:00:00.000Z"]);

    const first = commands[0].input;
    expect(first.KeyConditionExpression).toBe("PK = :pk AND SK BETWEEN :sk_start AND :sk_end");
    expect(first.ExpressionAttributeValues).toEqual({
      ":pk": "DEPLOYMENT#j1",
      ":sk_start": "EVENT#2026-06-02T00:00:00.000Z",
      ":sk_end": "EVENT#~",
    });
    expect(first.ScanIndexForward).toBe(false);
  });

  it("should list inbox events over an SK range (same query, InboxEventRecord shape)", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([
      inboxItem("j1", "INBOX#2026-06-05T00:00:00.000Z#a", { kind: "sabotage" }),
      scoreEventItem("j1", "EVENT#2026-06-05T00:00:00.000Z#b"), // must NOT be in range
    ]);
    reset();

    const rows = await repo.listInboxEventsInRange(
      "j1",
      "INBOX#2026-06-01T00:00:00.000Z",
      "INBOX#~",
    );
    expect(rows).toEqual([
      {
        eventId: "ev-1",
        fromTeamId: "team-2",
        fromJobId: "01FROMJOB",
        kind: "sabotage",
        payload: { amount: 1 },
        occurredAt: "2026-06-05T00:00:00.000Z",
        ttl: 4102444800,
      },
    ]);
    expect(commands[0].input.KeyConditionExpression).toBe(
      "PK = :pk AND SK BETWEEN :sk_start AND :sk_end",
    );
  });

  it("should drain all pages of an SK range", async () => {
    const { repo, seed } = makeRepo(2); // 2 rows per page, no explicit Limit
    await seed(
      ["a", "b", "c", "d", "e"].map((id) =>
        scoreEventItem("j1", `EVENT#2026-06-01T00:00:0${id.charCodeAt(0) - 96}.000Z#${id}`),
      ),
    );
    const rows = await repo.listScoreEventsInRange("j1", "EVENT#2026", "EVENT#~");
    expect(rows).toHaveLength(5);
  });

  it("should read coordination state, defaulting version to 0 when absent", async () => {
    const { repo, seed, commands, reset } = makeRepo();
    await seed([coordItem("tenant-a", "ev-1", { state: { turns: 4 }, version: 7 })]);
    reset();

    const state = await repo.readCoordinationState(coordScope("tenant-a", "ev-1"));
    expect(state).toEqual({ state: { turns: 4 }, version: 7 });

    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands[0].input.Key).toEqual({
      PK: "COORD#tenant-a#ev-1#problem-a#default",
      SK: "STATE",
    });

    expect(await repo.readCoordinationState(coordScope("tenant-a", "missing"))).toBeUndefined();
  });

  it("should default coordination version to 0 for a row missing the version attribute", async () => {
    const { repo, seed } = makeRepo();
    await seed([{ PK: "COORD#tenant-a#ev-2#problem-a#default", SK: "STATE", state: { x: 1 } }]);
    expect(await repo.readCoordinationState(coordScope("tenant-a", "ev-2"))).toEqual({
      state: { x: 1 },
      version: 0,
    });
  });

  /**
   * [Issue #3123] The regression this issue exists for: one event, two
   * coordination problems. Before the key carried problem and run they shared a
   * single row, so the second problem's first write clobbered the first
   * problem's match and left its next honest write looking like a conflict.
   */
  it("should keep two problems in one event on separate rows", async () => {
    const { repo, seed } = makeRepo();
    await seed([
      coordItem("tenant-a", "ev-1", { state: { turns: 4 }, version: 7 }, "problem-a"),
      coordItem("tenant-a", "ev-1", { state: { turns: 9 }, version: 2 }, "problem-b"),
    ]);
    expect(await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-a"))).toEqual({
      state: { turns: 4 },
      version: 7,
    });
    expect(await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-b"))).toEqual({
      state: { turns: 9 },
      version: 2,
    });
  });

  /** [Issue #3123] Two runs of the SAME problem are separate too. */
  it("should keep two runs of one problem on separate rows", async () => {
    const { repo, seed } = makeRepo();
    await seed([
      coordItem("tenant-a", "ev-1", { state: { turns: 1 } }, "problem-a", "run-1"),
      coordItem("tenant-a", "ev-1", { state: { turns: 2 } }, "problem-a", "run-2"),
    ]);
    expect(
      await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-a", "run-1")),
    ).toMatchObject({ state: { turns: 1 } });
    expect(
      await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-a", "run-2")),
    ).toMatchObject({ state: { turns: 2 } });
  });

  /**
   * [Issue #3123] Cleanup removes exactly the named namespace, plus the
   * pre-scope row for that event (nothing else reaps those — they predate
   * `expiresAt`). Every other namespace is untouched, and a repeat is a no-op.
   */
  it("should delete one namespace idempotently and leave the others alone", async () => {
    const { repo, seed } = makeRepo();
    await seed([
      coordItem("tenant-a", "ev-1", { state: { turns: 4 } }, "problem-a"),
      coordItem("tenant-a", "ev-1", { state: { turns: 9 } }, "problem-b"),
      { PK: "COORD#tenant-a#ev-1", SK: "STATE", state: { legacy: true }, version: 1 },
    ]);

    await repo.deleteCoordinationState(coordScope("tenant-a", "ev-1", "problem-a"));
    await repo.deleteCoordinationState(coordScope("tenant-a", "ev-1", "problem-a"));

    expect(
      await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-a")),
    ).toBeUndefined();
    expect(await repo.readCoordinationState(coordScope("tenant-a", "ev-1", "problem-b"))).toEqual({
      state: { turns: 9 },
      version: 2,
    });
  });
});

describe("createDeploymentsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), deploymentsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createDeploymentsRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbDeploymentsRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createDeploymentsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbDeploymentsRepository,
    );
  });

  it("should select the SQL backend for the turso flag", () => {
    expect(createDeploymentsRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlDeploymentsRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createDeploymentsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createDeploymentsRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it.each([
    "sql",
    "turso-mirror",
    "sql-mirror",
  ])("should reject the removed %s backend value (#2677)", (backend) => {
    expect(() => createDeploymentsRepository(backend, ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createDeploymentsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createDeploymentsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("resolveDeploymentsRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveDeploymentsRepository({
      ddb: makeFakeDdb(),
      deploymentsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbDeploymentsRepository);
  });

  it("should return the SQL backend for CONTROL_DATA_BACKEND=turso without DDB inputs", async () => {
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "file:local.db",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/sql-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } }) },
      createClient: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 }),
        batch: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(runtime.resolveDeploymentsRepository({})).resolves.toBeInstanceOf(
      SqlDeploymentsRepository,
    );
  });

  it("should fail loudly when the dynamodb backend is missing ddb/deploymentsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "dynamodb" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveDeploymentsRepository({ ddb: makeFakeDdb() })).rejects.toThrow(
      /dynamodb backend requires ddb\/deploymentsTableName/,
    );
  });
});
