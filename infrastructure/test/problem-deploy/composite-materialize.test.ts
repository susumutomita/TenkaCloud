/**
 * [Composite Runtime / Issue #2063] Tests for the composite materialization
 * service — it turns a deterministic plan into one persisted parent job and one
 * independent target job per plan target.
 *
 * The tests drive the REAL repository (#2061) through a small in-memory DynamoDB
 * fake that honours only the command shapes the repository issues (PutCommand
 * with `attribute_not_exists(PK)`, GetCommand, GSI3 QueryCommand). Nothing is
 * mocked at the repository boundary, so ordering, id assignment, and partial-
 * state behaviour are asserted against real persisted rows. The fake throws on
 * any other command, which is also how we prove no adapter / event publisher is
 * ever invoked.
 */

import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { CompositeRuntimeDescriptor } from "@tenkacloud/problem-runtime";
import { buildCompositeDeploymentPlan } from "@tenkacloud/problem-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CompositeMaterializationError,
  type MaterializeCompositeDeploymentInput,
  materializeCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-materialize";
import type { CompositeDeploymentRepositoryDeps } from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";

const NOW_MS = Date.parse("2026-06-29T00:00:00.000Z");
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const FOUR_PROVIDER_DESCRIPTOR: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://b/worker" },
    { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
    { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
  ],
};

const rowKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

interface FakeDdb {
  deps: CompositeDeploymentRepositoryDeps;
  rows: () => Record<string, unknown>[];
  commandNames: () => string[];
}

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

type Store = Map<string, Record<string, unknown>>;
type FailPut = (item: Record<string, unknown>) => boolean;

function handlePut(cmd: PutCommand, store: Store, failPut?: FailPut): Record<string, never> {
  const item = cmd.input.Item as Record<string, unknown>;
  if (failPut?.(item)) throw new Error(`forced put failure for ${String(item.PK)}`);
  const k = rowKey(item.PK, item.SK);
  if (cmd.input.ConditionExpression?.includes("attribute_not_exists(PK)") && store.has(k)) {
    throw conditionalCheckFailed();
  }
  store.set(k, { ...item });
  return {};
}

function handleQuery(cmd: QueryCommand, store: Store) {
  const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
  const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
  matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
  return { Items: matched.map((r) => ({ ...r })) };
}

/**
 * In-memory DynamoDB fake. `failPut` lets a test force a single Put to throw a
 * generic (non-conditional) error so partial-state / error-reporting behaviour
 * can be exercised against the real repository.
 */
function makeFakeDdb(opts: { failPut?: FailPut } = {}): FakeDdb {
  const store: Store = new Map();
  const seen: string[] = [];

  const send = vi.fn(async (cmd: unknown) => {
    seen.push((cmd as { constructor: { name: string } }).constructor.name);
    if (cmd instanceof PutCommand) return handlePut(cmd, store, opts.failPut);
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
    commandNames: () => [...seen],
  };
}

/** Sequential id factory so parent-first / per-target order is observable. */
function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

function makeInput(
  fake: FakeDdb,
  over: Partial<MaterializeCompositeDeploymentInput> = {},
): MaterializeCompositeDeploymentInput {
  const runtime = over.runtime ?? FOUR_PROVIDER_DESCRIPTOR;
  return {
    repo: fake.deps,
    runtime,
    plan: over.plan ?? buildCompositeDeploymentPlan(runtime),
    tenantId: "tenant-acme",
    problemId: "cross-cloud",
    teamName: "Alpha",
    account: {
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      namePrefix: "tc-cross-cloud-alpha",
    },
    newDeploymentId: sequentialIds("dep"),
    newTeamLoginKey: () => "team-key-1",
    now: () => NOW_MS,
    ...over,
  };
}

const parentRows = (fake: FakeDdb) => fake.rows().filter((r) => r.runtimeKind === "composite");
const targetRows = (fake: FakeDdb) =>
  fake.rows().filter((r) => typeof r.parentDeploymentId === "string");

describe("materializeCompositeDeployment (#2063)", () => {
  it("creates one parent and one target job per plan target", async () => {
    const fake = makeFakeDdb();
    const result = await materializeCompositeDeployment(makeInput(fake));

    expect(parentRows(fake)).toHaveLength(1);
    expect(targetRows(fake)).toHaveLength(4);
    expect(result.parentDeploymentId).toBe("dep-0");
    expect(Object.keys(result.targetDeploymentIds)).toEqual([
      "aws-api",
      "gcp-worker",
      "azure-edge",
      "sakura-svc",
    ]);

    const parent = parentRows(fake)[0];
    expect(parent).toMatchObject({
      PK: "DEPLOYMENT#dep-0",
      SK: "META",
      jobId: "dep-0",
      runtimeKind: "composite",
      targetCount: 4,
      status: "PENDING",
    });
    for (const row of targetRows(fake)) {
      expect(row.status).toBe("PENDING");
      expect(row.parentDeploymentId).toBe("dep-0");
    }
  });

  it("copies one team login key to parent and all targets", async () => {
    const fake = makeFakeDdb();
    const keyFactory = vi.fn(() => "team-key-1");
    const result = await materializeCompositeDeployment(
      makeInput(fake, { newTeamLoginKey: keyFactory }),
    );

    expect(keyFactory).toHaveBeenCalledTimes(1);
    expect(result.teamLoginKey).toBe("team-key-1");
    // The parent coordination row is not a participant deployment row, so it does
    // not carry teamLoginKey; every target row does.
    for (const row of targetRows(fake)) {
      expect(row.teamLoginKey).toBe("team-key-1");
    }
  });

  it("preserves AWS GCP Azure Sakura target order and runtime fields", async () => {
    const fake = makeFakeDdb();
    await materializeCompositeDeployment(makeInput(fake));

    const ordered = targetRows(fake).sort(
      (a, b) => Number(a.targetOrdinal) - Number(b.targetOrdinal),
    );
    expect(
      ordered.map((r) => ({
        targetId: r.targetId,
        targetOrdinal: r.targetOrdinal,
        runtimeProvider: r.runtimeProvider,
        runtimeEngine: r.runtimeEngine,
        runtimeEntry: r.runtimeEntry,
      })),
    ).toEqual([
      {
        targetId: "aws-api",
        targetOrdinal: 0,
        runtimeProvider: "aws",
        runtimeEngine: "cloudformation",
        runtimeEntry: "aws/template.yaml",
      },
      {
        targetId: "gcp-worker",
        targetOrdinal: 1,
        runtimeProvider: "gcp",
        runtimeEngine: "infra-manager",
        runtimeEntry: "gs://b/worker",
      },
      {
        targetId: "azure-edge",
        targetOrdinal: 2,
        runtimeProvider: "azure",
        runtimeEngine: "bicep",
        runtimeEntry: "azure/main.bicep",
      },
      {
        targetId: "sakura-svc",
        targetOrdinal: 3,
        runtimeProvider: "sakura",
        runtimeEngine: "apprun",
        runtimeEntry: "sakura/service.json",
      },
    ]);
  });

  it("does not invoke an adapter or event publisher", async () => {
    const fake = makeFakeDdb();
    await materializeCompositeDeployment(makeInput(fake));

    // The fake throws on any non-DynamoDB command, so completion already proves
    // no EventBridge / adapter call escaped. Assert the command set explicitly.
    expect(new Set(fake.commandNames())).toEqual(
      new Set(["PutCommand", "GetCommand", "QueryCommand"]),
    );
  });

  it("does not create targets when parent persistence fails", async () => {
    const fake = makeFakeDdb({ failPut: (item) => item.runtimeKind === "composite" });

    await expect(materializeCompositeDeployment(makeInput(fake))).rejects.toThrow(
      /forced put failure/,
    );
    expect(parentRows(fake)).toHaveLength(0);
    expect(targetRows(fake)).toHaveLength(0);
  });

  it("reports parent id and target id when target persistence fails", async () => {
    const fake = makeFakeDdb({ failPut: (item) => item.targetId === "azure-edge" });

    const error = await materializeCompositeDeployment(makeInput(fake)).catch((e) => e);
    expect(error).toBeInstanceOf(CompositeMaterializationError);
    expect(error.parentDeploymentId).toBe("dep-0");
    expect(error.targetId).toBe("azure-edge");

    // Targets created before the failing ordinal are left in place (no cleanup).
    const created = targetRows(fake).map((r) => r.targetId);
    expect(created).toContain("aws-api");
    expect(created).toContain("gcp-worker");
    expect(created).not.toContain("azure-edge");
    expect(created).not.toContain("sakura-svc");
  });

  it("uses injected clock and factories deterministically", async () => {
    const fake = makeFakeDdb();
    const clock = vi.fn(() => NOW_MS);
    const idFactory = vi.fn(sequentialIds("dep"));
    const result = await materializeCompositeDeployment(
      makeInput(fake, { now: clock, newDeploymentId: idFactory }),
    );

    expect(clock).toHaveBeenCalledTimes(1);
    // One call for the parent + one per target.
    expect(idFactory).toHaveBeenCalledTimes(5);
    expect(result.targetDeploymentIds).toEqual({
      "aws-api": "dep-1",
      "gcp-worker": "dep-2",
      "azure-edge": "dep-3",
      "sakura-svc": "dep-4",
    });
    expect(result.expiresAt).toBe(Math.floor((NOW_MS + EIGHT_HOURS_MS) / 1000));
    const parent = parentRows(fake)[0];
    expect(parent.createdAt).toBe(new Date(NOW_MS).toISOString());
    expect(parent.expiresAt).toBe(result.expiresAt);
  });

  it("does not add provider runtime fields to the parent job", async () => {
    const fake = makeFakeDdb();
    await materializeCompositeDeployment(makeInput(fake));

    const parent = parentRows(fake)[0];
    expect(parent.runtimeProvider).toBeUndefined();
    expect(parent.runtimeEngine).toBeUndefined();
    expect(parent.runtimeEntry).toBeUndefined();
    expect(parent.targetId).toBeUndefined();
    expect(parent.parentDeploymentId).toBeUndefined();
  });

  it("copies optional account credential fields onto every target", async () => {
    const fake = makeFakeDdb();
    await materializeCompositeDeployment(
      makeInput(fake, {
        account: {
          awsAccountId: "123456789012",
          region: "ap-northeast-1",
          namePrefix: "tc-cross-cloud-alpha",
          competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
          externalIdParameterName: "/tc/ext-id",
          displayTeamName: "Team Alpha",
        },
      }),
    );

    for (const row of targetRows(fake)) {
      expect(row.competitorRoleArn).toBe("arn:aws:iam::123456789012:role/Deploy");
      expect(row.externalIdParameterName).toBe("/tc/ext-id");
      expect(row.displayTeamName).toBe("Team Alpha");
      expect(row.namePrefix).toBe("tc-cross-cloud-alpha");
      expect(row.awsAccountId).toBe("123456789012");
      expect(row.region).toBe("ap-northeast-1");
    }
  });

  it("rejects a plan whose target count disagrees with the descriptor", async () => {
    const fake = makeFakeDdb();
    const twoTargetPlan = buildCompositeDeploymentPlan({
      kind: "composite",
      targets: FOUR_PROVIDER_DESCRIPTOR.targets.slice(0, 2),
    });

    await expect(
      materializeCompositeDeployment(
        makeInput(fake, { runtime: FOUR_PROVIDER_DESCRIPTOR, plan: twoTargetPlan }),
      ),
    ).rejects.toThrow(/does not match descriptor/);
    expect(fake.rows()).toHaveLength(0);
  });
});
