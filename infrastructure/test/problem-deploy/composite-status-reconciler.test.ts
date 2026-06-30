/**
 * [Composite Runtime / Issue #2068] Tests for the composite parent deploy-status
 * reconciler + its scheduled scan.
 *
 * Seeds a real parent + four targets through the #2061 repository into an
 * in-memory DynamoDB fake (Put/Get/Query/Update/Scan), then drives the reconciler
 * so aggregation (#2067), conditional writes, no-target-mutation, scan filtering,
 * and per-target-then-parent ordering are asserted against real persisted state.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import {
  CompositeParentNotReconcilableError,
  reconcileCompositeParentDeployStatus,
  reconcileCompositeParents,
  reconcileCompositeParentTeardownStatus,
  reconcileCompositeTeardowns,
  reconcileDeployStatusMaintenance,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler";

const NOW_ISO = "2026-06-29T00:00:00.000Z";
const NEXT_ISO = "2026-06-29T01:00:00.000Z";
const EXPIRES_AT = 9_999_999_999;
const PARENT = "parent-1";
const PROVIDERS = [
  {
    id: "t-aws",
    targetId: "aws-api",
    ordinal: 0,
    provider: "aws",
    engine: "cloudformation",
    entry: "aws/t.yaml",
  },
  {
    id: "t-gcp",
    targetId: "gcp-worker",
    ordinal: 1,
    provider: "gcp",
    engine: "infra-manager",
    entry: "gs://b/w",
  },
  {
    id: "t-azure",
    targetId: "azure-edge",
    ordinal: 2,
    provider: "azure",
    engine: "bicep",
    entry: "azure/m.bicep",
  },
  {
    id: "t-sakura",
    targetId: "sakura-svc",
    ordinal: 3,
    provider: "sakura",
    engine: "apprun",
    entry: "sakura/s.json",
  },
] as const;

const rowKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

interface Fake {
  deps: CompositeDeploymentRepositoryDeps & { deploymentsTableName: string };
  store: Map<string, Record<string, unknown>>;
  commands: string[];
  setStatus: (id: string, status: string) => void;
  status: (id: string) => unknown;
}

function handleUpdate(
  cmd: UpdateCommand,
  store: Map<string, Record<string, unknown>>,
  failUpdate: boolean,
) {
  if (failUpdate) throw conditionalCheckFailed();
  const row = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  // Deploy update guards on #s = :prev; teardown update guards on #s = :deleting.
  const expectedStatus = vals[":prev"] ?? vals[":deleting"];
  if (row?.status !== expectedStatus || row?.runtimeKind !== vals[":composite"]) {
    throw conditionalCheckFailed();
  }
  if (row) {
    row.status = vals[":next"] ?? vals[":deleted"];
    row.updatedAt = vals[":now"];
  }
  return {};
}

function handleScan(cmd: ScanCommand, store: Map<string, Record<string, unknown>>) {
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  // Deploy scan: runtimeKind = :composite AND status IN (:p,:i).
  // Teardown scan: runtimeKind = :composite AND status = :deleting.
  const items = [...store.values()].filter((r) => {
    if (r.runtimeKind !== vals[":composite"]) return false;
    if (vals[":deleting"] !== undefined) return r.status === vals[":deleting"];
    return r.status === vals[":p"] || r.status === vals[":i"];
  });
  return { Items: items.map((r) => ({ ...r })) };
}

function makeFake(opts: { failUpdate?: boolean } = {}): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const commands: string[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    commands.push((cmd as { constructor: { name: string } }).constructor.name);
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      store.set(rowKey(item.PK, item.SK), { ...item });
      return {};
    }
    if (cmd instanceof GetCommand) {
      const item = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
      return { Item: item ? { ...item } : undefined };
    }
    if (cmd instanceof QueryCommand) {
      const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
      const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
      matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
      return { Items: matched.map((r) => ({ ...r })) };
    }
    if (cmd instanceof UpdateCommand) return handleUpdate(cmd, store, opts.failUpdate ?? false);
    if (cmd instanceof ScanCommand) return handleScan(cmd, store);
    throw new Error(`unexpected: ${(cmd as { constructor: { name: string } }).constructor.name}`);
  });
  return {
    deps: { ddb: { send }, tableName: "T", deploymentsTableName: "T" },
    store,
    commands,
    setStatus: (id, status) => {
      const row = store.get(`DEPLOYMENT#${id}|META`);
      if (row) row.status = status;
    },
    status: (id) => store.get(`DEPLOYMENT#${id}|META`)?.status,
  };
}

async function seed(fake: Fake): Promise<void> {
  await createCompositeParent(fake.deps, {
    parentDeploymentId: PARENT,
    tenantId: "tenant-acme",
    problemId: "cross-cloud",
    targetCount: 4,
    createdAt: NOW_ISO,
    expiresAt: EXPIRES_AT,
  });
  for (const p of PROVIDERS) {
    await createCompositeTarget(fake.deps, {
      targetDeploymentId: p.id,
      parentDeploymentId: PARENT,
      targetId: p.targetId,
      targetOrdinal: p.ordinal,
      tenantId: "tenant-acme",
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
    });
  }
}

describe("reconcileCompositeParentDeployStatus (#2068)", () => {
  it("updates parent to IN_PROGRESS after one target starts", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "IN_PROGRESS");
    const r = await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r).toMatchObject({
      previousStatus: "PENDING",
      nextStatus: "IN_PROGRESS",
      changed: true,
    });
    expect(fake.status(PARENT)).toBe("IN_PROGRESS");
  });

  it("updates parent to COMPLETE only when all targets are COMPLETE", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "COMPLETE");
    fake.setStatus(PARENT, "IN_PROGRESS");
    await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(fake.status(PARENT)).toBe("COMPLETE");
  });

  it("updates parent to FAILED when any target is FAILED", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-azure", "FAILED");
    fake.setStatus(PARENT, "IN_PROGRESS");
    const r = await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.nextStatus).toBe("FAILED");
    expect(fake.status(PARENT)).toBe("FAILED");
  });

  it("does not update a parent when the aggregate status is unchanged", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "IN_PROGRESS");
    fake.setStatus(PARENT, "IN_PROGRESS"); // already matches the aggregate
    fake.commands.length = 0;
    const r = await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.commands).not.toContain("UpdateCommand");
  });

  it("does not modify target rows", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "COMPLETE");
    const before = PROVIDERS.map((p) => ({ ...fake.store.get(`DEPLOYMENT#${p.id}|META`) }));
    await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    const after = PROVIDERS.map((p) => ({ ...fake.store.get(`DEPLOYMENT#${p.id}|META`) }));
    expect(after).toEqual(before);
  });

  it("throws when asked to reconcile a target row as a parent", async () => {
    const fake = makeFake();
    await seed(fake);
    await expect(
      reconcileCompositeParentDeployStatus(fake.deps, {
        parentDeploymentId: "t-aws",
        nowIso: NEXT_ISO,
      }),
    ).rejects.toBeInstanceOf(CompositeParentNotReconcilableError);
  });

  it("treats a conditional update race as a no-op", async () => {
    const fake = makeFake({ failUpdate: true });
    await seed(fake);
    fake.setStatus("t-aws", "IN_PROGRESS");
    const r = await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("PENDING"); // unchanged
  });

  it("skips a malformed (deletion-like) target set without guessing", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "DELETED"); // deletion-like → aggregator throws → skip
    fake.setStatus(PARENT, "IN_PROGRESS");
    fake.commands.length = 0;
    const r = await reconcileCompositeParentDeployStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.commands).not.toContain("UpdateCommand");
    expect(fake.status(PARENT)).toBe("IN_PROGRESS");
  });
});

describe("reconcileCompositeParents scan (#2068)", () => {
  it("progresses only composite parents and ignores legacy single-provider rows", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "IN_PROGRESS");
    // A legacy single-provider row (no runtimeKind) that must be excluded.
    fake.store.set("DEPLOYMENT#legacy|META", {
      PK: "DEPLOYMENT#legacy",
      SK: "META",
      jobId: "legacy",
      status: "PENDING",
      runtimeProvider: "aws",
    });

    await reconcileCompositeParents(fake.deps, NEXT_ISO);

    expect(fake.status(PARENT)).toBe("IN_PROGRESS"); // composite parent advanced
    expect(fake.status("legacy")).toBe("PENDING"); // legacy untouched
  });
});

describe("reconcileCompositeParentTeardownStatus (#2072)", () => {
  async function seedDeleting(fake: ReturnType<typeof makeFake>, statuses: Record<string, string>) {
    await seed(fake);
    fake.setStatus(PARENT, "DELETING");
    for (const [id, status] of Object.entries(statuses)) fake.setStatus(id, status);
  }

  it("marks parent DELETED when all targets are DELETED", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "DELETED",
      "t-azure": "DELETED",
      "t-sakura": "DELETED",
    });
    const r = await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r).toMatchObject({ previousStatus: "DELETING", nextStatus: "DELETED", changed: true });
    expect(fake.status(PARENT)).toBe("DELETED");
  });

  it("marks parent DELETED when targets are mixed deleted-like states", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "EXPIRED",
      "t-azure": "AUTO_DELETED",
      "t-sakura": "DELETED",
    });
    await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(fake.status(PARENT)).toBe("DELETED");
  });

  it("keeps parent DELETING when any target is still DELETING", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "DELETING",
      "t-azure": "DELETED",
      "t-sakura": "DELETED",
    });
    const r = await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("keeps parent DELETING when any target is FAILED (operator inspection)", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "FAILED",
      "t-azure": "DELETED",
      "t-sakura": "DELETED",
    });
    await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("does not mutate target rows", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "DELETED",
      "t-azure": "DELETED",
      "t-sakura": "DELETED",
    });
    const before = PROVIDERS.map((p) => ({ ...fake.store.get(`DEPLOYMENT#${p.id}|META`) }));
    await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    const after = PROVIDERS.map((p) => ({ ...fake.store.get(`DEPLOYMENT#${p.id}|META`) }));
    expect(after).toEqual(before);
  });

  it("does not process a non-composite parent (target row)", async () => {
    const fake = makeFake();
    await seedDeleting(fake, {});
    await expect(
      reconcileCompositeParentTeardownStatus(fake.deps, {
        parentDeploymentId: "t-aws",
        nowIso: NEXT_ISO,
      }),
    ).rejects.toBeInstanceOf(CompositeParentNotReconcilableError);
  });

  it("treats a conditional update race as a no-op", async () => {
    const fake = makeFake({ failUpdate: true });
    await seedDeleting(fake, {
      "t-aws": "DELETED",
      "t-gcp": "DELETED",
      "t-azure": "DELETED",
      "t-sakura": "DELETED",
    });
    const r = await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("DELETING"); // unchanged
  });

  it("skips a malformed empty target set", async () => {
    const fake = makeFake();
    // A composite parent in DELETING with no target rows.
    fake.store.set(`DEPLOYMENT#${PARENT}|META`, {
      PK: `DEPLOYMENT#${PARENT}`,
      SK: "META",
      jobId: PARENT,
      runtimeKind: "composite",
      status: "DELETING",
    });
    fake.commands.length = 0;
    const r = await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.commands).not.toContain("UpdateCommand");
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("ignores a parent that is not in DELETING", async () => {
    const fake = makeFake();
    await seed(fake); // parent PENDING
    fake.commands.length = 0;
    const r = await reconcileCompositeParentTeardownStatus(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.commands).not.toContain("UpdateCommand");
  });
});

describe("reconcileCompositeTeardowns scan (#2072)", () => {
  it("finalizes only DELETING composite parents and ignores deploy-phase parents", async () => {
    const fake = makeFake();
    await seed(fake); // PENDING parent + targets
    fake.setStatus(PARENT, "DELETING");
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");

    await reconcileCompositeTeardowns(fake.deps, NEXT_ISO);

    expect(fake.status(PARENT)).toBe("DELETED");
  });
});

describe("reconcileDeployStatusMaintenance ordering (#2068 / #2072)", () => {
  it("runs per-target reconciliation before the composite deploy + teardown scans", async () => {
    const fake = makeFake();
    const order: string[] = [];
    // Record each composite scan (deploy scan, then teardown scan).
    const origSend = fake.deps.ddb.send as ReturnType<typeof vi.fn>;
    origSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ScanCommand) order.push("composite-scan");
      return { Items: [] };
    });

    await reconcileDeployStatusMaintenance(fake.deps, NEXT_ISO, async () => {
      order.push("per-target");
    });

    // per-target first, then the deploy-parent scan, then the teardown scan.
    expect(order).toEqual(["per-target", "composite-scan", "composite-scan"]);
  });
});
