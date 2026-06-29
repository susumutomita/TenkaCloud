/**
 * [Composite Runtime / Issue #2066] Tests for composite target dispatch.
 *
 * Seeds a real parent + four target rows through the #2061 repository into an
 * in-memory DynamoDB fake (Put/Get/Query/Update), then dispatches with injected
 * fake adapters and a fake connection resolver — so adapter selection, per-target
 * failure isolation, FAILED writes, idempotency, and "no row creation" are all
 * asserted against real persisted state without reaching a cloud.
 *
 * The legacy single-provider AWS EventBridge detail / startDeployment behavior is
 * out of scope here and stays covered by `deploy-runtime-dispatch.test.ts` and
 * `composite-compat-single-provider.test.ts`; this module never touches that path.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CompositeDispatchDeps,
  dispatchCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import type {
  ResolveCompositeTargetConnectionInput,
  TargetConnection,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-connection";

const NOW_ISO = "2026-06-29T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const EXPIRES_AT = 9_999_999_999;
const PARENT = "parent-1";

const PROVIDERS = [
  {
    targetDeploymentId: "t-aws",
    targetId: "aws-api",
    ordinal: 0,
    provider: "aws",
    engine: "cloudformation",
    entry: "aws/template.yaml",
  },
  {
    targetDeploymentId: "t-gcp",
    targetId: "gcp-worker",
    ordinal: 1,
    provider: "gcp",
    engine: "infra-manager",
    entry: "gs://b/worker",
  },
  {
    targetDeploymentId: "t-azure",
    targetId: "azure-edge",
    ordinal: 2,
    provider: "azure",
    engine: "bicep",
    entry: "azure/main.bicep",
  },
  {
    targetDeploymentId: "t-sakura",
    targetId: "sakura-svc",
    ordinal: 3,
    provider: "sakura",
    engine: "apprun",
    entry: "sakura/service.json",
  },
] as const;

const rowKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

interface Fake {
  deps: CompositeDeploymentRepositoryDeps;
  store: Map<string, Record<string, unknown>>;
  commands: string[];
  resetLog: () => void;
}

function handleUpdate(cmd: UpdateCommand, store: Map<string, Record<string, unknown>>) {
  const key = rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK);
  const row = store.get(key);
  const values = cmd.input.ExpressionAttributeValues ?? {};
  // Only the markTargetFailed shape is issued: SET status/failureReason/updatedAt
  // guarded by `#s = :pending`.
  if (cmd.input.ConditionExpression?.includes(":pending") && row?.status !== values[":pending"]) {
    throw conditionalCheckFailed();
  }
  if (row) {
    row.status = values[":failed"];
    row.failureReason = values[":reason"];
    row.updatedAt = values[":now"];
  }
  return {};
}

function makeFake(): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const commands: string[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    commands.push((cmd as { constructor: { name: string } }).constructor.name);
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      const k = rowKey(item.PK, item.SK);
      if (cmd.input.ConditionExpression?.includes("attribute_not_exists(PK)") && store.has(k)) {
        throw conditionalCheckFailed();
      }
      store.set(k, { ...item });
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
    if (cmd instanceof UpdateCommand) return handleUpdate(cmd, store);
    throw new Error(
      `unexpected command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
    );
  });
  return {
    deps: { ddb: { send }, tableName: "TestDeployments" },
    store,
    commands,
    resetLog: () => {
      commands.length = 0;
    },
  };
}

async function seedComposite(fake: Fake): Promise<void> {
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
      targetDeploymentId: p.targetDeploymentId,
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
      namePrefix: "tc-cross-cloud-alpha",
      teamLoginKey: "team-key-1",
      createdAt: NOW_ISO,
      expiresAt: EXPIRES_AT,
    });
  }
}

function rowStatus(fake: Fake, targetDeploymentId: string): unknown {
  return fake.store.get(`DEPLOYMENT#${targetDeploymentId}|META`)?.status;
}

/** Fake adapters keyed by provider; each records its calls. */
function makeAdapters() {
  const callOrder: string[] = [];
  const adapters = Object.fromEntries(
    PROVIDERS.map((p) => [
      p.provider,
      {
        deploy: vi.fn(async () => {
          callOrder.push(p.provider);
          return { status: "IN_PROGRESS" as const };
        }),
      },
    ]),
  );
  return { adapters, callOrder };
}

function makeDeps(
  fake: Fake,
  adapters: Record<string, { deploy: ReturnType<typeof vi.fn> }>,
  over: Partial<CompositeDispatchDeps> = {},
): CompositeDispatchDeps {
  return {
    repo: fake.deps,
    resolveConnection: async (
      input: ResolveCompositeTargetConnectionInput,
    ): Promise<TargetConnection> => {
      if (input.provider === "aws") {
        return {
          provider: "aws",
          awsAccountId: input.awsAccountId,
          region: input.region,
          competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
          externalIdParameterName: "/test/tenants/tenant-acme/external-id",
        };
      }
      return { provider: input.provider, teamSlug: input.teamSlug };
    },
    selectAdapter: ({ provider }) => adapters[provider],
    problemsCatalog: { "cross-cloud": "problems/challenges/cross-cloud" },
    now: () => NOW_MS,
    ...over,
  };
}

describe("dispatchCompositeDeployment (#2066)", () => {
  it("dispatches AWS GCP Azure and Sakura targets once in ordinal order", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters, callOrder } = makeAdapters();

    const result = await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);

    expect(callOrder).toEqual(["aws", "gcp", "azure", "sakura"]);
    for (const p of PROVIDERS) expect(adapters[p.provider].deploy).toHaveBeenCalledTimes(1);
    expect(result.targets.map((t) => t.outcome)).toEqual([
      "started",
      "started",
      "started",
      "started",
    ]);
    expect(result.targets.map((t) => t.targetId)).toEqual([
      "aws-api",
      "gcp-worker",
      "azure-edge",
      "sakura-svc",
    ]);
  });

  it("continues dispatching remaining targets after one preflight failure", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    const deps = makeDeps(fake, adapters, {
      resolveConnection: async (input) => {
        if (input.provider === "gcp") throw new Error("missing gcp connection");
        if (input.provider === "aws") {
          return {
            provider: "aws",
            awsAccountId: input.awsAccountId,
            region: input.region,
            competitorRoleArn: "arn",
            externalIdParameterName: "/p",
          };
        }
        return { provider: input.provider, teamSlug: input.teamSlug };
      },
    });

    const result = await dispatchCompositeDeployment(deps, PARENT);

    const byId = Object.fromEntries(result.targets.map((t) => [t.targetId, t.outcome]));
    expect(byId["gcp-worker"]).toBe("preflight_failed");
    expect(byId["aws-api"]).toBe("started");
    expect(byId["azure-edge"]).toBe("started");
    expect(byId["sakura-svc"]).toBe("started");
    expect(adapters.gcp.deploy).not.toHaveBeenCalled();
    expect(adapters.aws.deploy).toHaveBeenCalledTimes(1);
    expect(rowStatus(fake, "t-gcp")).toBe("FAILED");
  });

  it("continues dispatching remaining targets after one adapter failure", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    adapters.azure.deploy.mockRejectedValueOnce(new Error("ARM rejected"));

    const result = await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);

    const byId = Object.fromEntries(result.targets.map((t) => [t.targetId, t.outcome]));
    expect(byId["azure-edge"]).toBe("dispatch_failed");
    expect(byId["aws-api"]).toBe("started");
    expect(byId["sakura-svc"]).toBe("started");
    expect(rowStatus(fake, "t-azure")).toBe("FAILED");
    expect(rowStatus(fake, "t-sakura")).toBe("PENDING"); // started targets stay PENDING
  });

  it("marks only failed targets FAILED with a non-secret reason", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    const SECRET = "SUPER-SECRET-TOKEN";
    adapters.sakura.deploy.mockRejectedValueOnce(new Error(`leak ${SECRET}`));

    await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);

    expect(rowStatus(fake, "t-aws")).toBe("PENDING");
    expect(rowStatus(fake, "t-sakura")).toBe("FAILED");
    const reason = fake.store.get("DEPLOYMENT#t-sakura|META")?.failureReason as string;
    expect(reason).not.toContain(SECRET); // class name only, never the message
    expect(reason).toContain("dispatch failed");
  });

  it("does not update parent status", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);
    expect(fake.store.get(`DEPLOYMENT#${PARENT}|META`)?.status).toBe("PENDING");
  });

  it("does not invoke a target that is not PENDING", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    // Simulate the provider path having advanced the AWS target.
    const awsRow = fake.store.get("DEPLOYMENT#t-aws|META");
    if (awsRow) awsRow.status = "IN_PROGRESS";
    const { adapters } = makeAdapters();

    const result = await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);

    expect(adapters.aws.deploy).not.toHaveBeenCalled();
    expect(result.targets.find((t) => t.targetId === "aws-api")?.outcome).toBe("dispatch_failed");
    expect(rowStatus(fake, "t-aws")).toBe("IN_PROGRESS"); // untouched, not re-FAILED
  });

  it("does not double-dispatch on a second invocation", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    const deps = makeDeps(fake, adapters);

    await dispatchCompositeDeployment(deps, PARENT);
    // The provider paths advance the started targets off PENDING.
    for (const p of PROVIDERS) {
      const row = fake.store.get(`DEPLOYMENT#${p.targetDeploymentId}|META`);
      if (row) row.status = "IN_PROGRESS";
    }
    await dispatchCompositeDeployment(deps, PARENT);

    for (const p of PROVIDERS) expect(adapters[p.provider].deploy).toHaveBeenCalledTimes(1);
  });

  it("does not create any deployment row", async () => {
    const fake = makeFake();
    await seedComposite(fake);
    const { adapters } = makeAdapters();
    fake.resetLog(); // ignore the seed phase

    await dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT);

    expect(fake.commands).not.toContain("PutCommand"); // loads + FAILED updates only
  });

  it("rejects when the parent is missing or targets are incomplete", async () => {
    const fake = makeFake();
    const { adapters } = makeAdapters();
    await expect(dispatchCompositeDeployment(makeDeps(fake, adapters), "nope")).rejects.toThrow(
      /not found or not a composite parent/,
    );

    // Parent present but a target missing.
    await createCompositeParent(fake.deps, {
      parentDeploymentId: PARENT,
      tenantId: "tenant-acme",
      problemId: "cross-cloud",
      targetCount: 4,
      createdAt: NOW_ISO,
      expiresAt: EXPIRES_AT,
    });
    await expect(dispatchCompositeDeployment(makeDeps(fake, adapters), PARENT)).rejects.toThrow(
      /expects 4 targets but found 0/,
    );
  });
});
