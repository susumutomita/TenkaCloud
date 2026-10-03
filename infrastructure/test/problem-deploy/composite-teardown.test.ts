/**
 * [Composite Runtime / Issue #2071] Tests for composite teardown fan-out.
 *
 * Seeds a real parent + four targets through the #2061 repository into an
 * in-memory DynamoDB fake (Put/Get/Query/Update), and injects a fake per-target
 * teardown. Asserts fan-out order, the parent → DELETING transition before any
 * target teardown, deleted-like skip (no re-invocation), failure isolation, and
 * that no row is deleted. The AWS-EventBridge / non-AWS-adapter routing inside the
 * per-target teardown is covered by delete.ts's existing tests; here we verify the
 * orchestrator delegates to it once per eligible target.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import {
  type CompositeTeardownDeps,
  CompositeTeardownError,
  requestCompositeTeardown,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-teardown";
import type { TeardownOutcome } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_ISO = "2026-06-29T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const EXPIRES_AT = 9_999_999_999;
const PARENT = "parent-1";
const TENANT = "tenant-acme";
const PROVIDERS = [
  {
    id: "t-aws",
    targetId: "aws-api",
    ordinal: 0,
    provider: "aws",
    engine: "cloudformation",
    entry: "a/t.yaml",
  },
  {
    id: "t-gcp",
    targetId: "gcp-worker",
    ordinal: 1,
    provider: "gcp",
    engine: "infra-manager",
    entry: "g/w",
  },
  {
    id: "t-azure",
    targetId: "azure-edge",
    ordinal: 2,
    provider: "azure",
    engine: "bicep",
    entry: "a/m.bicep",
  },
  {
    id: "t-sakura",
    targetId: "sakura-svc",
    ordinal: 3,
    provider: "sakura",
    engine: "apprun",
    entry: "s/s.json",
  },
] as const;

const rowKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

interface Fake {
  repo: CompositeDeploymentRepositoryDeps;
  store: Map<string, Record<string, unknown>>;
  order: string[];
}

type Store = Map<string, Record<string, unknown>>;

function handleQuery(cmd: QueryCommand, store: Store) {
  const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
  const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
  matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
  return { Items: matched.map((r) => ({ ...r })) };
}

function handleUpdate(cmd: UpdateCommand, store: Store, order: string[]) {
  const row = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  if (row?.status === vals[":deleting"]) {
    const err = new Error("cond") as Error & { name: string };
    err.name = "ConditionalCheckFailedException";
    throw err; // already DELETING → no-op
  }
  order.push("parent-deleting");
  if (row) row.status = vals[":deleting"];
  return {};
}

function makeFake(): Fake {
  const store: Store = new Map();
  const order: string[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      store.set(rowKey(item.PK, item.SK), { ...item });
      return {};
    }
    if (cmd instanceof GetCommand) {
      const item = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
      return { Item: item ? { ...item } : undefined };
    }
    if (cmd instanceof QueryCommand) return handleQuery(cmd, store);
    if (cmd instanceof UpdateCommand) return handleUpdate(cmd, store, order);
    throw new Error("unexpected command");
  });
  return {
    repo: { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "T" },
    store,
    order,
  };
}

async function seed(fake: Fake, statuses: Record<string, string> = {}): Promise<void> {
  await createCompositeParent(fake.repo, {
    parentDeploymentId: PARENT,
    tenantId: TENANT,
    problemId: "cross-cloud",
    targetCount: 4,
    createdAt: NOW_ISO,
    expiresAt: EXPIRES_AT,
  });
  for (const p of PROVIDERS) {
    await createCompositeTarget(fake.repo, {
      targetDeploymentId: p.id,
      parentDeploymentId: PARENT,
      targetId: p.targetId,
      targetOrdinal: p.ordinal,
      tenantId: TENANT,
      problemId: "cross-cloud",
      provider: p.provider,
      engine: p.engine,
      entry: p.entry,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "Alpha",
      namePrefix: "tc-x",
      teamLoginKey: "k",
      createdAt: NOW_ISO,
      expiresAt: EXPIRES_AT,
      status: (statuses[p.id] as never) ?? "COMPLETE",
    });
  }
}

const accepted: TeardownOutcome = { kind: "accepted", previousStatus: "COMPLETE" };

function makeDeps(
  fake: Fake,
  teardownTarget: CompositeTeardownDeps["teardownTarget"],
): CompositeTeardownDeps {
  return { repo: fake.repo, teardownTarget, now: () => NOW_MS };
}

describe("requestCompositeTeardown (#2071)", () => {
  it("requests teardown for AWS GCP Azure and Sakura targets in ordinal order", async () => {
    const fake = makeFake();
    await seed(fake);
    const seen: string[] = [];
    const teardown = vi.fn(async (id: string) => {
      seen.push(id);
      return accepted;
    });
    const result = await requestCompositeTeardown(makeDeps(fake, teardown), {
      parentDeploymentId: PARENT,
      tenantId: TENANT,
    });

    expect(seen).toEqual(["t-aws", "t-gcp", "t-azure", "t-sakura"]);
    expect(result.targets.map((t) => t.outcome)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(result.targets.map((t) => t.targetId)).toEqual([
      "aws-api",
      "gcp-worker",
      "azure-edge",
      "sakura-svc",
    ]);
  });

  it("sets the parent to DELETING before the first target teardown request", async () => {
    const fake = makeFake();
    await seed(fake);
    const teardown = vi.fn(async (id: string) => {
      fake.order.push(`teardown:${id}`);
      return accepted;
    });
    await requestCompositeTeardown(makeDeps(fake, teardown), {
      parentDeploymentId: PARENT,
      tenantId: TENANT,
    });
    expect(fake.order[0]).toBe("parent-deleting");
    expect(fake.store.get(`DEPLOYMENT#${PARENT}|META`)?.status).toBe("DELETING");
  });

  it("continues after one target teardown request fails", async () => {
    const fake = makeFake();
    await seed(fake);
    const teardown = vi.fn(async (id: string) => {
      if (id === "t-gcp") throw new Error("gcp teardown boom");
      return accepted;
    });
    const result = await requestCompositeTeardown(makeDeps(fake, teardown), {
      parentDeploymentId: PARENT,
      tenantId: TENANT,
    });
    const byId = Object.fromEntries(result.targets.map((t) => [t.targetId, t.outcome]));
    expect(byId["gcp-worker"]).toBe("failed");
    expect(byId["aws-api"]).toBe("accepted");
    expect(byId["sakura-svc"]).toBe("accepted");
    expect(teardown).toHaveBeenCalledTimes(4); // all eligible targets attempted
  });

  it("does not reinvoke already deleting / deleted / expired / auto-deleted targets", async () => {
    const fake = makeFake();
    await seed(fake, {
      "t-gcp": "DELETING",
      "t-azure": "DELETED",
      "t-sakura": "EXPIRED",
    });
    const teardown = vi.fn(async () => accepted);
    const result = await requestCompositeTeardown(makeDeps(fake, teardown), {
      parentDeploymentId: PARENT,
      tenantId: TENANT,
    });
    // Only the COMPLETE AWS target is dispatched.
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith("t-aws");
    const byId = Object.fromEntries(result.targets.map((t) => [t.targetId, t.outcome]));
    expect(byId["gcp-worker"]).toBe("already_deleted");
    expect(byId["azure-edge"]).toBe("already_deleted");
    expect(byId["sakura-svc"]).toBe("already_deleted");
  });

  it("maps a per-target race to not_dispatchable", async () => {
    const fake = makeFake();
    await seed(fake);
    const teardown = vi.fn(
      async (id: string): Promise<TeardownOutcome> =>
        id === "t-aws" ? { kind: "race", reason: "tenant_or_status_mismatch" } : accepted,
    );
    const result = await requestCompositeTeardown(makeDeps(fake, teardown), {
      parentDeploymentId: PARENT,
      tenantId: TENANT,
    });
    expect(result.targets.find((t) => t.targetId === "aws-api")?.outcome).toBe("not_dispatchable");
  });

  it("does not delete parent or target records", async () => {
    const fake = makeFake();
    await seed(fake);
    const sizeBefore = fake.store.size;
    await requestCompositeTeardown(
      makeDeps(
        fake,
        vi.fn(async () => accepted),
      ),
      {
        parentDeploymentId: PARENT,
        tenantId: TENANT,
      },
    );
    expect(fake.store.size).toBe(sizeBefore); // 1 parent + 4 targets still present
    expect(fake.store.has(`DEPLOYMENT#${PARENT}|META`)).toBe(true);
    for (const p of PROVIDERS) expect(fake.store.has(`DEPLOYMENT#${p.id}|META`)).toBe(true);
  });

  it("is idempotent: a repeat request on an already-DELETING parent re-fans-out without error", async () => {
    const fake = makeFake();
    await seed(fake);
    const teardown = vi.fn(async () => accepted);
    const deps = makeDeps(fake, teardown);
    await requestCompositeTeardown(deps, { parentDeploymentId: PARENT, tenantId: TENANT });
    // Parent now DELETING; the second call's parent update is a no-op (caught).
    fake.order.length = 0;
    await expect(
      requestCompositeTeardown(deps, { parentDeploymentId: PARENT, tenantId: TENANT }),
    ).resolves.toBeDefined();
    expect(fake.order).not.toContain("parent-deleting"); // conditional no-op
  });

  it("rejects a missing parent and a cross-tenant parent as not-found", async () => {
    const fake = makeFake();
    await seed(fake);
    await expect(
      requestCompositeTeardown(
        makeDeps(
          fake,
          vi.fn(async () => accepted),
        ),
        {
          parentDeploymentId: "nope",
          tenantId: TENANT,
        },
      ),
    ).rejects.toBeInstanceOf(CompositeTeardownError);
    await expect(
      requestCompositeTeardown(
        makeDeps(
          fake,
          vi.fn(async () => accepted),
        ),
        {
          parentDeploymentId: PARENT,
          tenantId: "other-tenant",
        },
      ),
    ).rejects.toBeInstanceOf(CompositeTeardownError);
  });
});
