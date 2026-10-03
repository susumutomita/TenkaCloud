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
  CompositeParentConflictError,
  CompositeTargetConflictError,
  type CreateCompositeParentInput,
  type CreateCompositeTargetInput,
  createCompositeParent,
  createCompositeTarget,
  getCompositeParent,
  getCompositeTarget,
  listCompositeTargets,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

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
    deps: { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "TestDeployments" },
    rows: () => [...store.values()],
    putCount: (pk: string) => puts.filter((p) => p === pk).length,
  };
}

function stripPhysicalKeys(row: Record<string, unknown>): Record<string, unknown> {
  const record = { ...row };
  delete record.PK;
  delete record.SK;
  delete record.GSI3PK;
  delete record.GSI3SK;
  return record;
}

const parentInput = (
  over: Partial<CreateCompositeParentInput> = {},
): CreateCompositeParentInput => ({
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
    // [#2063] No team identity unless supplied — keeps the legacy parent shape.
    expect(created).not.toHaveProperty("teamLoginKey");
    expect(created).not.toHaveProperty("teamName");

    const fetched = await getCompositeParent(fake.deps, "parent-1");
    expect(fetched).toEqual(stripPhysicalKeys(created));
  });

  it("[#2063] stores team identity on the parent when supplied", async () => {
    const fake = makeFakeDdb();
    const created = await createCompositeParent(
      fake.deps,
      parentInput({ teamName: "Alpha", teamLoginKey: "KEY1" }),
    );
    expect(created.teamName).toBe("Alpha");
    expect(created.teamLoginKey).toBe("KEY1");
  });

  it("[#2063] stores request grouping fields on the parent and target", async () => {
    const fake = makeFakeDdb();
    const parent = await createCompositeParent(
      fake.deps,
      parentInput({ accountGroupId: "accounts-a", problemSetId: "set-1" }),
    );
    const target = await createCompositeTarget(
      fake.deps,
      targetInput({ accountGroupId: "accounts-a", problemSetId: "set-1" }),
    );

    expect(parent.accountGroupId).toBe("accounts-a");
    expect(parent.problemSetId).toBe("set-1");
    expect(target.accountGroupId).toBe("accounts-a");
    expect(target.problemSetId).toBe("set-1");
  });

  it("[#2747] stores the dependency + output-binding graph metadata on the target", async () => {
    const fake = makeFakeDdb();
    const target = await createCompositeTarget(
      fake.deps,
      targetInput({
        executionWave: 2,
        dependsOn: ["aws-api"],
        inputs: { Endpoint: { fromTarget: "aws-api", output: "Endpoint" } },
        outputs: { Endpoint: { sensitivity: "public" } },
      }),
    );

    expect(target.compositeExecutionWave).toBe(2);
    expect(target.compositeDependsOn).toEqual(["aws-api"]);
    expect(target.compositeInputs).toEqual({
      Endpoint: { fromTarget: "aws-api", output: "Endpoint" },
    });
    expect(target.compositeOutputs).toEqual({ Endpoint: { sensitivity: "public" } });
  });

  it("[#2747] omits the dependency + output-binding graph metadata when absent (legacy shape)", async () => {
    const fake = makeFakeDdb();
    const target = await createCompositeTarget(fake.deps, targetInput());

    expect(target).not.toHaveProperty("compositeExecutionWave");
    expect(target).not.toHaveProperty("compositeDependsOn");
    expect(target).not.toHaveProperty("compositeInputs");
    expect(target).not.toHaveProperty("compositeOutputs");
  });

  it("[#2747] omits an empty dependsOn / inputs / outputs the same as absent", async () => {
    const fake = makeFakeDdb();
    const target = await createCompositeTarget(
      fake.deps,
      targetInput({ dependsOn: [], inputs: {}, outputs: {} }),
    );

    expect(target).not.toHaveProperty("compositeDependsOn");
    expect(target).not.toHaveProperty("compositeInputs");
    expect(target).not.toHaveProperty("compositeOutputs");
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
        jobId: p.targetDeploymentId,
        parentDeploymentId: "parent-1",
        targetId: p.targetId,
        targetOrdinal: p.targetOrdinal,
        runtimeProvider: p.provider,
        runtimeEngine: p.engine,
        runtimeEntry: p.entry,
      });
      expect(row).not.toHaveProperty("PK");
      expect(row).not.toHaveProperty("SK");
      expect(row).not.toHaveProperty("GSI3PK");
      expect(row).not.toHaveProperty("GSI3SK");
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

  it("retries an identical target write idempotently with a non-empty dependsOn graph (#2747)", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    // dependsOn is non-empty on both sides so the retry's order-sensitive `sameDependsOn`
    // comparison actually walks elements instead of short-circuiting on two empty arrays.
    const withDependsOn = targetInput({ dependsOn: ["upstream-a", "upstream-b"] });
    const first = await createCompositeTarget(fake.deps, withDependsOn);
    const retry = await createCompositeTarget(fake.deps, withDependsOn);

    expect(retry).toEqual(first);
    expect(fake.putCount("DEPLOYMENT#target-aws")).toBe(1);
  });

  it("rejects a target retry with a different dependsOn graph (#2747)", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput({ dependsOn: ["upstream-a"] }));

    await expect(
      createCompositeTarget(fake.deps, targetInput({ dependsOn: ["upstream-b"] })),
    ).rejects.toBeInstanceOf(CompositeTargetConflictError);
  });

  it("rejects a target retry with a different-length dependsOn graph (#2747)", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput({ dependsOn: ["upstream-a"] }));

    await expect(
      createCompositeTarget(fake.deps, targetInput({ dependsOn: ["upstream-a", "upstream-b"] })),
    ).rejects.toBeInstanceOf(CompositeTargetConflictError);
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

  it("rejects a targetCount outside 2..8", async () => {
    const fake = makeFakeDdb();
    await expect(
      createCompositeParent(fake.deps, parentInput({ targetCount: 1 })),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      createCompositeParent(fake.deps, parentInput({ targetCount: 9 })),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("retries an identical parent write idempotently", async () => {
    const fake = makeFakeDdb();
    const first = await createCompositeParent(fake.deps, parentInput());
    const retry = await createCompositeParent(fake.deps, parentInput());
    expect(retry).toEqual(first);
  });

  it("rejects a parent retry with a different immutable field", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await expect(
      createCompositeParent(fake.deps, parentInput({ problemId: "other-problem" })),
    ).rejects.toBeInstanceOf(CompositeParentConflictError);
  });

  it("[#2063] rejects a parent retry with different shared team identity", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(
      fake.deps,
      parentInput({ teamName: "Alpha", teamLoginKey: "KEY1" }),
    );
    await expect(
      createCompositeParent(fake.deps, parentInput({ teamName: "Beta", teamLoginKey: "KEY2" })),
    ).rejects.toBeInstanceOf(CompositeParentConflictError);
  });

  it("rejects a negative targetOrdinal", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await expect(
      createCompositeTarget(fake.deps, targetInput({ targetOrdinal: -1 })),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects a target whose id already holds a non-composite-target row", async () => {
    // A composite parent row sits at "parent-1"; trying to write a target at the
    // same deploymentId must conflict rather than silently overwrite the parent.
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await expect(
      createCompositeTarget(fake.deps, targetInput({ targetDeploymentId: "parent-1" })),
    ).rejects.toBeInstanceOf(CompositeTargetConflictError);
  });

  it("rejects a target lost to a concurrent writer at the same id", async () => {
    // Get + GSI3 query both see no row, but the conditional Put loses the race.
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: undefined };
      if (cmd instanceof QueryCommand) return { Items: [] };
      if (cmd instanceof PutCommand) {
        throw conditionalCheckFailed();
      }
      throw new Error("unexpected");
    });
    const deps = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send },
      tableName: "TestDeployments",
    };
    await expect(createCompositeTarget(deps, targetInput())).rejects.toBeInstanceOf(
      CompositeTargetConflictError,
    );
  });

  it("returns undefined when getCompositeParent hits a non-parent row", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    await createCompositeTarget(fake.deps, targetInput());
    // "target-aws" is a target, not a parent → undefined.
    expect(await getCompositeParent(fake.deps, "target-aws")).toBeUndefined();
    // absent id → undefined.
    expect(await getCompositeParent(fake.deps, "missing")).toBeUndefined();
  });

  it("returns undefined when getCompositeTarget hits a non-target row", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(fake.deps, parentInput());
    // "parent-1" is a parent, not a target → undefined.
    expect(await getCompositeTarget(fake.deps, "parent-1")).toBeUndefined();
    expect(await getCompositeTarget(fake.deps, "missing")).toBeUndefined();
  });

  it("returns an empty target list when the GSI3 query yields no Items field", async () => {
    const send = vi.fn(async () => ({}) as { Items?: undefined });
    const targets = await listCompositeTargets(
      { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "TestDeployments" },
      "parent-1",
    );
    expect(targets).toEqual([]);
  });

  it("rethrows a non-conditional DDB error from the parent write", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof PutCommand) throw new Error("throughput exceeded");
      return { Item: undefined };
    });
    await expect(
      createCompositeParent(
        { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "TestDeployments" },
        parentInput(),
      ),
    ).rejects.toThrow(/throughput exceeded/);
  });

  it("rethrows a non-conditional DDB error from the target write", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: undefined };
      if (cmd instanceof QueryCommand) return { Items: [] };
      if (cmd instanceof PutCommand) throw new Error("throughput exceeded");
      throw new Error("unexpected");
    });
    await expect(
      createCompositeTarget(
        { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "TestDeployments" },
        targetInput(),
      ),
    ).rejects.toThrow(/throughput exceeded/);
  });

  it("persists explicit status / updatedAt and optional cross-account fields on a target", async () => {
    const fake = makeFakeDdb();
    await createCompositeParent(
      fake.deps,
      parentInput({ status: "IN_PROGRESS", updatedAt: "2026-06-28T01:00:00.000Z" }),
    );
    const created = await createCompositeTarget(
      fake.deps,
      targetInput({
        status: "IN_PROGRESS",
        updatedAt: "2026-06-28T02:00:00.000Z",
        competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
        externalIdParameterName: "/development/tenants/tenant-acme/external-id",
        displayTeamName: "Team Alpha",
      }),
    );

    expect(created).toMatchObject({
      status: "IN_PROGRESS",
      updatedAt: "2026-06-28T02:00:00.000Z",
      competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
      externalIdParameterName: "/development/tenants/tenant-acme/external-id",
      displayTeamName: "Team Alpha",
    });

    const parent = await getCompositeParent(fake.deps, "parent-1");
    expect(parent?.status).toBe("IN_PROGRESS");
    expect(parent?.updatedAt).toBe("2026-06-28T01:00:00.000Z");
  });
});
