/**
 * [Composite Runtime / Issue #2061] Repository tests for composite parent +
 * per-target deployment persistence.
 *
 * Uses a small in-memory DynamoDB fake that honours the only command shapes the
 * repository issues (PutCommand with `attribute_not_exists(PK)`, GetCommand,
 * GSI3 QueryCommand). This lets the tests assert real ordering, idempotency,
 * conflict, and partial-state behaviour rather than mock-call bookkeeping.
 */

import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CompositeDeploymentRepositoryDeps,
  CompositeTargetConflictError,
  type CreateCompositeTargetInput,
  createCompositeParent,
  createCompositeTarget,
  getCompositeParent,
  getCompositeTarget,
  listCompositeTargets,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";

const NOW_ISO = "2026-06-28T00:00:00.000Z";
const EXPIRES_AT = 9_999_999_999;

interface FakeDdb {
  deps: CompositeDeploymentRepositoryDeps;
  rows: () => Record<string, unknown>[];
  putCount: (pk: string) => number;
}

const rowKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

function handlePut(
  cmd: PutCommand,
  store: Map<string, Record<string, unknown>>,
  puts: string[],
): Record<string, never> {
  const item = cmd.input.Item as Record<string, unknown>;
  const k = rowKey(item.PK, item.SK);
  if (cmd.input.ConditionExpression?.includes("attribute_not_exists(PK)") && store.has(k)) {
    throw conditionalCheckFailed();
  }
  puts.push(String(item.PK));
  store.set(k, { ...item });
  return {};
}

function handleQuery(cmd: QueryCommand, store: Map<string, Record<string, unknown>>) {
  const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
  const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
  matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
  const ordered = cmd.input.ScanIndexForward === false ? matched.reverse() : matched;
  return { Items: ordered.map((r) => ({ ...r })) };
}

function makeFakeDdb(): FakeDdb {
  const store = new Map<string, Record<string, unknown>>();
  const puts: string[] = [];

  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof PutCommand) return handlePut(cmd, store, puts);
    if (cmd instanceof GetCommand) {
      const item = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
      return { Item: item ? { ...item } : undefined };
    }
    if (cmd instanceof QueryCommand) return handleQuery(cmd, store);
    throw new Error(
      `unexpected command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
    );
  });

  return {
    deps: { ddb: { send }, tableName: "TestDeployments" },
    rows: () => [...store.values()],
    putCount: (pk: string) => puts.filter((p) => p === pk).length,
  };
}

const parentInput = (over: Record<string, unknown> = {}) => ({
  parentDeploymentId: "parent-1",
  tenantId: "tenant-acme",
  problemId: "cross-cloud",
  targetCount: 2,
  createdAt: NOW_ISO,
  expiresAt: EXPIRES_AT,
  ...over,
});

const targetInput = (
  over: Partial<CreateCompositeTargetInput> = {},
): CreateCompositeTargetInput => ({
  targetDeploymentId: "target-aws",
  parentDeploymentId: "parent-1",
  targetId: "aws-api",
  targetOrdinal: 0,
  tenantId: "tenant-acme",
  problemId: "cross-cloud",
  provider: "aws",
  engine: "cloudformation",
  entry: "aws/template.yaml",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-cross-cloud-alpha-aws",
  teamLoginKey: "KEY1",
  createdAt: NOW_ISO,
  expiresAt: EXPIRES_AT,
  ...over,
});

describe("composite deployment repository (#2061)", () => {
  it("stores a composite parent at a META key", async () => {
    const fake = makeFakeDdb();
    const created = await createCompositeParent(fake.deps, parentInput());
    expect(created).toMatchObject({
      PK: "DEPLOYMENT#parent-1",
      SK: "META",
      jobId: "parent-1",
      runtimeKind: "composite",
      compositeVersion: 1,
      targetCount: 2,
      status: "PENDING",
    });

    const fetched = await getCompositeParent(fake.deps, "parent-1");
    expect(fetched).toEqual(created);
  });

  it("stores AWS GCP Azure and Sakura targets as independent META rows", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput({ targetCount: 4 }));

    const providers = [
      {
        targetDeploymentId: "t-aws",
        targetId: "aws-api",
        targetOrdinal: 0,
        provider: "aws",
        engine: "cloudformation",
        entry: "aws/template.yaml",
      },
      {
        targetDeploymentId: "t-gcp",
        targetId: "gcp-worker",
        targetOrdinal: 1,
        provider: "gcp",
        engine: "infra-manager",
        entry: "gs://b/worker",
      },
      {
        targetDeploymentId: "t-azure",
        targetId: "azure-edge",
        targetOrdinal: 2,
        provider: "azure",
        engine: "bicep",
        entry: "azure/main.bicep",
      },
      {
        targetDeploymentId: "t-sakura",
        targetId: "sakura-svc",
        targetOrdinal: 3,
        provider: "sakura",
        engine: "apprun",
        entry: "sakura/service.json",
      },
    ] as const;
    for (const p of providers) await createCompositeTarget(fake.deps, targetInput(p));

    for (const p of providers) {
      const row = await getCompositeTarget(fake.deps, p.targetDeploymentId);
      expect(row).toMatchObject({
        PK: `DEPLOYMENT#${p.targetDeploymentId}`,
        SK: "META",
        jobId: p.targetDeploymentId,
        parentDeploymentId: "parent-1",
        targetId: p.targetId,
        targetOrdinal: p.targetOrdinal,
        runtimeProvider: p.provider,
        runtimeEngine: p.engine,
        runtimeEntry: p.entry,
      });
    }
    // 1 parent + 4 targets, each its own row.
    expect(fake.rows()).toHaveLength(5);
  });

  it("stores a parent lookup key only on target rows", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput());

    const parentRow = fake.rows().find((r) => r.PK === "DEPLOYMENT#parent-1");
    const targetRow = fake.rows().find((r) => r.PK === "DEPLOYMENT#target-aws");
    expect(parentRow).not.toHaveProperty("GSI3PK");
    expect(parentRow).not.toHaveProperty("GSI3SK");
    expect(targetRow?.GSI3PK).toBe("PARENT_DEPLOYMENT#parent-1");
    expect(targetRow?.GSI3SK).toBe("ORDINAL#00#TARGET#aws-api");
  });

  it("queries targets in targetOrdinal order through GSI3", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput({ targetCount: 3 }));
    // Insert out of order to prove the index sort, not insertion order.
    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t2", targetId: "c", targetOrdinal: 2 }),
    );
    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t0", targetId: "a", targetOrdinal: 0 }),
    );
    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t1", targetId: "b", targetOrdinal: 1 }),
    );

    const targets = await listCompositeTargets(fake.deps, "parent-1");
    expect(targets.map((t) => t.targetOrdinal)).toEqual([0, 1, 2]);
    expect(targets.map((t) => t.targetId)).toEqual(["a", "b", "c"]);
  });

  it("does not alter legacy deployment PK SK GSI1 or GSI2 values", async () => {
    // Composite rows must never write into the legacy GSI1 (tenant) / GSI2
    // (teamLoginKey) keyspace, and must keep the standard DEPLOYMENT#/META PK/SK.
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput());

    for (const row of fake.rows()) {
      expect(row.SK).toBe("META");
      expect(String(row.PK).startsWith("DEPLOYMENT#")).toBe(true);
      expect(row).not.toHaveProperty("GSI1PK");
      expect(row).not.toHaveProperty("GSI1SK");
      expect(row).not.toHaveProperty("GSI2PK");
      expect(row).not.toHaveProperty("GSI2SK");
    }
  });

  it("does not return target rows from existing tenant deployment list query", async () => {
    // The existing list query is `GSI1PK = TENANT#<tenantId>`. Composite parent +
    // target rows carry no GSI1PK, so they can never match it.
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput());

    const tenantListMatches = fake.rows().filter((r) => r.GSI1PK === "TENANT#tenant-acme");
    expect(tenantListMatches).toHaveLength(0);
  });

  it("rejects conflicting duplicate target id within one parent", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t-1", targetId: "dup", targetOrdinal: 0 }),
    );

    await expect(
      createCompositeTarget(
        fake.deps,
        targetInput({ targetDeploymentId: "t-2", targetId: "dup", targetOrdinal: 1 }),
      ),
    ).rejects.toBeInstanceOf(CompositeTargetConflictError);
  });

  it("allows the same target id under another parent", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput({ parentDeploymentId: "p-a" }));
    await createCompositeParent(fake.deps, parentInput({ parentDeploymentId: "p-b" }));

    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t-a", parentDeploymentId: "p-a", targetId: "shared" }),
    );
    const second = await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t-b", parentDeploymentId: "p-b", targetId: "shared" }),
    );
    expect(second.targetId).toBe("shared");
    expect(second.parentDeploymentId).toBe("p-b");
  });

  it("retries an identical target write idempotently", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    const first = await createCompositeTarget(fake.deps, targetInput());
    const retry = await createCompositeTarget(fake.deps, targetInput());

    expect(retry).toEqual(first);
    // The second call detected the existing row and did not issue a second Put.
    expect(fake.putCount("DEPLOYMENT#target-aws")).toBe(1);
  });

  it("rejects a target retry with different immutable fields", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput());

    await expect(
      // same targetDeploymentId, different engine (immutable) → loud conflict
      createCompositeTarget(fake.deps, targetInput({ engine: "cdk" })),
    ).rejects.toBeInstanceOf(CompositeTargetConflictError);
  });

  it("keeps partial target creation observable without changing parent status", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput({ targetCount: 2 }));
    // Only the first of two declared targets is created (partial state).
    await createCompositeTarget(
      fake.deps,
      targetInput({ targetDeploymentId: "t0", targetId: "a", targetOrdinal: 0 }),
    );

    const targets = await listCompositeTargets(fake.deps, "parent-1");
    expect(targets).toHaveLength(1);

    const parent = await getCompositeParent(fake.deps, "parent-1");
    expect(parent?.status).toBe("PENDING");
    expect(parent?.targetCount).toBe(2);
  });
});
