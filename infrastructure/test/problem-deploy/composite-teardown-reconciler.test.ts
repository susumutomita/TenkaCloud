/**
 * [Composite Runtime / Issue #2072] Tests for the composite parent TEARDOWN
 * completion reconciler + its scheduled scan.
 *
 * Seeds a real parent + four targets through the #2061 repository into an
 * in-memory DynamoDB fake (Put/Get/Query/Update/Scan), then drives the reconciler
 * so the deleted-like rule, conditional DELETING→DELETED write, no-target-mutation,
 * empty-set skip, scan filtering, and per-target-before-teardown ordering are
 * asserted against real persisted state.
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
import { reconcileDeployStatusMaintenance } from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler";
import {
  CompositeTeardownNotReconcilableError,
  reconcileCompositeParentTeardown,
  reconcileCompositeParentTeardowns,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-teardown-reconciler";

const NOW_ISO = "2026-06-29T00:00:00.000Z";
const NEXT_ISO = "2026-06-29T01:00:00.000Z";
const EXPIRES_AT = 9_999_999_999;
const PARENT = "parent-1";
const PROVIDERS = [
  { id: "t-aws", targetId: "aws-api", ordinal: 0, provider: "aws", engine: "cloudformation" },
  { id: "t-gcp", targetId: "gcp-worker", ordinal: 1, provider: "gcp", engine: "infra-manager" },
  { id: "t-azure", targetId: "azure-edge", ordinal: 2, provider: "azure", engine: "bicep" },
  { id: "t-sakura", targetId: "sakura-svc", ordinal: 3, provider: "sakura", engine: "apprun" },
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
  updatedAt: (id: string) => unknown;
}

function handleUpdate(
  cmd: UpdateCommand,
  store: Map<string, Record<string, unknown>>,
  failUpdate: boolean,
) {
  if (failUpdate) throw conditionalCheckFailed();
  const row = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  if (
    cmd.input.ConditionExpression?.includes(":prev") &&
    (row?.status !== vals[":prev"] || row?.runtimeKind !== vals[":composite"])
  ) {
    throw conditionalCheckFailed();
  }
  if (row) {
    row.status = vals[":next"];
    row.updatedAt = vals[":now"];
  }
  return {};
}

function handleScan(cmd: ScanCommand, store: Map<string, Record<string, unknown>>) {
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  // Mirrors the reconciler filter: runtimeKind = :composite AND status = :deleting.
  const items = [...store.values()].filter(
    (r) => r.runtimeKind === vals[":composite"] && r.status === vals[":deleting"],
  );
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
    updatedAt: (id) => store.get(`DEPLOYMENT#${id}|META`)?.updatedAt,
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
      entry: `${p.provider}/t`,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "Alpha",
      namePrefix: "tc-x",
      teamLoginKey: "k",
      createdAt: NOW_ISO,
      expiresAt: EXPIRES_AT,
    });
  }
  // Teardown started: parent is DELETING (mirrors #2071 requestCompositeTeardown).
  fake.setStatus(PARENT, "DELETING");
}

describe("reconcileCompositeParentTeardown (#2072)", () => {
  it("should mark parent DELETED when all targets are DELETED", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r).toMatchObject({ previousStatus: "DELETING", nextStatus: "DELETED", changed: true });
    expect(fake.status(PARENT)).toBe("DELETED");
    expect(fake.updatedAt(PARENT)).toBe(NEXT_ISO);
  });

  it("should mark parent DELETED when targets are mixed deleted-like states", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus("t-aws", "DELETED");
    fake.setStatus("t-gcp", "EXPIRED");
    fake.setStatus("t-azure", "AUTO_DELETED");
    fake.setStatus("t-sakura", "DELETED");
    await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(fake.status(PARENT)).toBe("DELETED");
  });

  it("should keep parent DELETING when any target is still DELETING", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    fake.setStatus("t-sakura", "DELETING");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r).toMatchObject({ nextStatus: "DELETING", changed: false });
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("should keep parent DELETING when any target teardown FAILED", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    fake.setStatus("t-azure", "FAILED");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("should not mutate any target row", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    for (const p of PROVIDERS) expect(fake.status(p.id)).toBe("DELETED");
    // The only Update issued is the parent row (key SK META on the parent PK).
    expect(fake.commands.filter((c) => c === "UpdateCommand")).toHaveLength(1);
  });

  it("should not process a non-composite parent", async () => {
    const fake = makeFake();
    await seed(fake);
    // A target row is not a composite parent.
    await expect(
      reconcileCompositeParentTeardown(fake.deps, {
        parentDeploymentId: "t-aws",
        nowIso: NEXT_ISO,
      }),
    ).rejects.toBeInstanceOf(CompositeTeardownNotReconcilableError);
  });

  it("should leave a parent that is not DELETING unchanged", async () => {
    const fake = makeFake();
    await seed(fake);
    fake.setStatus(PARENT, "COMPLETE");
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r).toMatchObject({ nextStatus: "COMPLETE", changed: false });
    expect(fake.status(PARENT)).toBe("COMPLETE");
  });

  it("should treat a conditional update race as a no-op", async () => {
    const fake = makeFake({ failUpdate: true });
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("DELETING");
  });

  it("should skip a malformed empty target set", async () => {
    const fake = makeFake();
    await createCompositeParent(fake.deps, {
      parentDeploymentId: PARENT,
      tenantId: "tenant-acme",
      problemId: "cross-cloud",
      targetCount: 4,
      createdAt: NOW_ISO,
      expiresAt: EXPIRES_AT,
    });
    fake.setStatus(PARENT, "DELETING");
    const r = await reconcileCompositeParentTeardown(fake.deps, {
      parentDeploymentId: PARENT,
      nowIso: NEXT_ISO,
    });
    expect(r.changed).toBe(false);
    expect(fake.status(PARENT)).toBe("DELETING");
  });
});

describe("reconcileCompositeParentTeardowns scan (#2072)", () => {
  it("should finalize only DELETING composite parents", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    await reconcileCompositeParentTeardowns(fake.deps, NEXT_ISO);
    expect(fake.status(PARENT)).toBe("DELETED");
  });

  it("should ignore a legacy single-provider row in DELETING", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    // A legacy row (no runtimeKind) that happens to be DELETING must be excluded.
    fake.store.set("DEPLOYMENT#legacy|META", {
      PK: "DEPLOYMENT#legacy",
      SK: "META",
      jobId: "legacy",
      status: "DELETING",
    });
    await reconcileCompositeParentTeardowns(fake.deps, NEXT_ISO);
    expect(fake.status(PARENT)).toBe("DELETED");
    expect(fake.status("legacy")).toBe("DELETING");
  });
});

describe("reconcileDeployStatusMaintenance teardown wiring (#2072)", () => {
  it("should run teardown reconciliation after individual target reconciliation", async () => {
    const fake = makeFake();
    await seed(fake);
    for (const p of PROVIDERS) fake.setStatus(p.id, "DELETED");
    fake.commands.length = 0; // ignore the commands issued while seeding
    let commandsWhenPerTargetRan = -1;
    await reconcileDeployStatusMaintenance(fake.deps, NEXT_ISO, async () => {
      commandsWhenPerTargetRan = fake.commands.length;
    });
    // The injected per-target step ran before any composite scan touched DDB...
    expect(commandsWhenPerTargetRan).toBe(0);
    // ...and the composite teardown scan ran afterwards and finalized the parent.
    expect(fake.commands).toContain("ScanCommand");
    expect(fake.status(PARENT)).toBe("DELETED");
  });
});
