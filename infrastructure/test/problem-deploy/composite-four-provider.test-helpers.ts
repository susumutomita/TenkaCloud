/**
 * [Composite Runtime / Issue #2079] Reusable four-provider Composite fixture +
 * in-memory DynamoDB fake.
 *
 * Exported so the contract suite (`composite-four-provider-contract.test.ts`) and
 * any later Composite issue can import ONE canonical four-provider shape instead
 * of re-declaring it. This is a TEST fixture only — it is NOT a production catalog
 * problem and it bypasses NO production validator (callers feed
 * `FOUR_PROVIDER_METADATA` / `FOUR_PROVIDER_RUNTIME` / `FOUR_PROVIDER_SCORING`
 * straight into the real `normalizeRuntime` / `buildCompositeDeploymentPlan` /
 * `parseScoringMetadata`).
 *
 * The in-memory DynamoDB fake mirrors the established composite test harness
 * (Put / Get / Query(GSI3) / Update / Scan over a `Map` keyed by `PK|SK`) so the
 * real repository + reconcilers run over genuine persisted state with no cloud,
 * no network, and no provider SDK credentials.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CompositeRuntimeDescriptor } from "@tenkacloud/problem-runtime";
import { vi } from "vitest";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import type {
  ResolveCompositeTargetConnectionInput,
  TargetConnection,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-connection";
import type { DeploymentStatus } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import type { CompositeParentReconcileDeps } from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler";
import type { CompositeTargetProvider } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/composite-probe";

// ---------------------------------------------------------------------------
// Deterministic clock + identity constants the whole suite pins.
// ---------------------------------------------------------------------------

export const FOUR_PROVIDER_PROBLEM_ID = "four-provider-relay";
export const FOUR_PROVIDER_PROBLEM_DIR = "problems/challenges/four-provider-relay";
export const FOUR_PROVIDER_TENANT_ID = "tenant-acme";
export const FOUR_PROVIDER_TEAM_NAME = "Alpha Team";
export const FOUR_PROVIDER_NOW_ISO = "2026-06-29T00:00:00.000Z";
export const FOUR_PROVIDER_NOW_MS = Date.parse(FOUR_PROVIDER_NOW_ISO);
export const FOUR_PROVIDER_AWS_ACCOUNT_ID = "123456789012";
export const FOUR_PROVIDER_REGION = "ap-northeast-1";
export const FOUR_PROVIDER_TEAM_LOGIN_KEY = "KEY1";
export const FOUR_PROVIDER_PARENT_ID = "parent-1";

/** The fixed expiry an 8h TTL from the fixed clock yields (epoch seconds). */
export const FOUR_PROVIDER_EXPIRES_AT = Math.floor(
  (FOUR_PROVIDER_NOW_MS + 8 * 60 * 60 * 1000) / 1000,
);

/** One fixture target row blueprint — declaration order is load-bearing. */
export interface FourProviderTarget {
  readonly targetId: string;
  readonly ordinal: number;
  readonly provider: CompositeTargetProvider;
  readonly engine: string;
  readonly entry: string;
  /** The CFn / runtime output key the composite-probe scorer reads for this target. */
  readonly outputKey: string;
}

/**
 * The fixture targets, in the EXACT declared order the issue mandates:
 *   aws-api → gcp-worker → azure-edge → sakura-service.
 * Every target intentionally exposes an output named `Url` so the namespacing
 * scenario can pin that duplicate output keys are kept per-targetId, not flattened.
 */
export const FOUR_PROVIDER_TARGETS: readonly FourProviderTarget[] = [
  {
    targetId: "aws-api",
    ordinal: 0,
    provider: "aws",
    engine: "cloudformation",
    entry: "aws/template.yaml",
    outputKey: "Url",
  },
  {
    targetId: "gcp-worker",
    ordinal: 1,
    provider: "gcp",
    engine: "infra-manager",
    entry: "gs://bucket/worker",
    outputKey: "Url",
  },
  {
    targetId: "azure-edge",
    ordinal: 2,
    provider: "azure",
    engine: "bicep",
    entry: "azure/main.bicep",
    outputKey: "Url",
  },
  {
    targetId: "sakura-service",
    ordinal: 3,
    provider: "sakura",
    engine: "apprun",
    entry: "sakura/service.json",
    outputKey: "Url",
  },
] as const;

/** The ordered targetId list — the canonical order every ordering assertion pins. */
export const FOUR_PROVIDER_TARGET_IDS: readonly string[] = FOUR_PROVIDER_TARGETS.map(
  (t) => t.targetId,
);

/** The runtime descriptor as it would appear in `metadata.json:runtime`. */
export const FOUR_PROVIDER_RUNTIME: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: FOUR_PROVIDER_TARGETS.map((t) => ({
    id: t.targetId,
    provider: t.provider,
    engine: t.engine,
    entry: t.entry,
  })),
};

/** The composite-probe scoring block as it would appear in `metadata.json:scoring`. */
export const FOUR_PROVIDER_SCORING = {
  kind: "composite-probe" as const,
  success: "all" as const,
  pointsAllOk: 400,
  targets: FOUR_PROVIDER_TARGETS.map((t) => ({
    targetId: t.targetId,
    probe: "https" as const,
    outputKey: t.outputKey,
  })),
};

/** The whole `metadata.json` for the fixture (id + runtime + scoring). */
export const FOUR_PROVIDER_METADATA = {
  id: FOUR_PROVIDER_PROBLEM_ID,
  runtime: FOUR_PROVIDER_RUNTIME,
  scoring: FOUR_PROVIDER_SCORING,
};

/** The synth-baked catalog map the deploy/dispatch paths consume. */
export const FOUR_PROVIDER_CATALOG: Readonly<Record<string, string>> = {
  [FOUR_PROVIDER_PROBLEM_ID]: FOUR_PROVIDER_PROBLEM_DIR,
};

/** The deployment id used for a seeded target, derived from its targetId. */
export function targetDeploymentId(targetId: string): string {
  return `t-${targetId}`;
}

/** The base output URL a target exposes in scenarios that probe it. */
export function targetUrl(targetId: string): string {
  return `https://${targetId}.example.invalid`;
}

// ---------------------------------------------------------------------------
// In-memory DynamoDB fake — Put / Get / Query(GSI3) / Update / Scan.
// ---------------------------------------------------------------------------

const rowKey = (pk: unknown, sk: unknown): string => `${String(pk)}|${String(sk)}`;

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

export interface FourProviderFake {
  readonly repo: CompositeDeploymentRepositoryDeps;
  readonly reconcileDeps: CompositeParentReconcileDeps;
  readonly store: Map<string, Record<string, unknown>>;
  readonly commands: string[];
  readonly setStatus: (deploymentId: string, status: DeploymentStatus) => void;
  readonly setOutputs: (deploymentId: string, raw: string) => void;
  readonly status: (deploymentId: string) => unknown;
  readonly resetLog: () => void;
}

/**
 * Apply the few UpdateExpression shapes the Composite modules issue:
 *   - markTargetFailed (#2066): SET status/failureReason/updatedAt IF `#s = :pending`;
 *   - markParentDeleting (#2071): SET ... IF runtimeKind composite AND `#s <> :deleting`;
 *   - reconcile deploy / teardown writes (#2068/#2072): SET ... IF `#s = :prev` ...
 * Conditional misses raise the same ConditionalCheckFailedException DynamoDB would.
 */
function handleUpdate(cmd: UpdateCommand, store: Map<string, Record<string, unknown>>): object {
  const key = rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK);
  const row = store.get(key);
  const values = cmd.input.ExpressionAttributeValues ?? {};
  const condition = cmd.input.ConditionExpression ?? "";

  if (condition.includes(":pending") && row?.status !== values[":pending"]) {
    throw conditionalCheckFailed();
  }
  if (condition.includes(":prev") && row?.status !== values[":prev"]) {
    throw conditionalCheckFailed();
  }
  if (condition.includes("<> :deleting") && row?.status === values[":deleting"]) {
    throw conditionalCheckFailed();
  }

  if (!row) return {};
  if (Object.hasOwn(values, ":failed")) {
    row.status = values[":failed"];
    row.failureReason = values[":reason"];
  } else if (Object.hasOwn(values, ":deleting")) {
    row.status = values[":deleting"];
  } else if (Object.hasOwn(values, ":next")) {
    row.status = values[":next"];
  }
  row.updatedAt = values[":now"];
  return {};
}

function handleScan(cmd: ScanCommand, store: Map<string, Record<string, unknown>>): object {
  const vals = cmd.input.ExpressionAttributeValues ?? {};
  const items = [...store.values()].filter((r) => {
    if (r.runtimeKind !== vals[":composite"]) return false;
    // Deploy reconcile filter: status IN (:p, :i). Teardown filter: status = :deleting.
    if (Object.hasOwn(vals, ":deleting")) return r.status === vals[":deleting"];
    return r.status === vals[":p"] || r.status === vals[":i"];
  });
  return { Items: items.map((r) => ({ ...r })) };
}

function handlePut(cmd: PutCommand, store: Map<string, Record<string, unknown>>): object {
  const item = cmd.input.Item as Record<string, unknown>;
  const k = rowKey(item.PK, item.SK);
  if (cmd.input.ConditionExpression?.includes("attribute_not_exists(PK)") && store.has(k)) {
    throw conditionalCheckFailed();
  }
  store.set(k, { ...item });
  return {};
}

function handleGet(cmd: GetCommand, store: Map<string, Record<string, unknown>>): object {
  const item = store.get(rowKey(cmd.input.Key?.PK, cmd.input.Key?.SK));
  return { Item: item ? { ...item } : undefined };
}

/** Emulate the GSI3 parent→target query: filter by GSI3PK, order by GSI3SK. */
function handleQuery(cmd: QueryCommand, store: Map<string, Record<string, unknown>>): object {
  const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
  const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
  matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
  return { Items: matched.map((r) => ({ ...r })) };
}

/** Dispatch one DynamoDB command to its in-memory handler. */
function dispatchCommand(cmd: unknown, store: Map<string, Record<string, unknown>>): object {
  if (cmd instanceof PutCommand) return handlePut(cmd, store);
  if (cmd instanceof GetCommand) return handleGet(cmd, store);
  if (cmd instanceof QueryCommand) return handleQuery(cmd, store);
  if (cmd instanceof UpdateCommand) return handleUpdate(cmd, store);
  if (cmd instanceof ScanCommand) return handleScan(cmd, store);
  throw new Error(
    `unexpected command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
  );
}

/** Build a fresh in-memory DynamoDB fake + repo/reconcile deps over it. */
export function makeFourProviderFake(): FourProviderFake {
  const store = new Map<string, Record<string, unknown>>();
  const commands: string[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    commands.push((cmd as { constructor: { name: string } }).constructor.name);
    return dispatchCommand(cmd, store);
  });
  const repo: CompositeDeploymentRepositoryDeps = { ddb: { send }, tableName: "TestDeployments" };
  return {
    repo,
    reconcileDeps: { ddb: { send }, deploymentsTableName: "TestDeployments" },
    store,
    commands,
    setStatus: (deploymentId, status) => {
      const row = store.get(`DEPLOYMENT#${deploymentId}|META`);
      if (row) row.status = status;
    },
    setOutputs: (deploymentId, raw) => {
      const row = store.get(`DEPLOYMENT#${deploymentId}|META`);
      if (row) row.stackOutputs = raw;
    },
    status: (deploymentId) => store.get(`DEPLOYMENT#${deploymentId}|META`)?.status,
    resetLog: () => {
      commands.length = 0;
    },
  };
}

/** Seed the fixture parent + four target rows through the REAL repository. */
export async function seedFourProvider(fake: FourProviderFake): Promise<void> {
  await createCompositeParent(fake.repo, {
    parentDeploymentId: FOUR_PROVIDER_PARENT_ID,
    tenantId: FOUR_PROVIDER_TENANT_ID,
    problemId: FOUR_PROVIDER_PROBLEM_ID,
    targetCount: FOUR_PROVIDER_TARGETS.length,
    createdAt: FOUR_PROVIDER_NOW_ISO,
    expiresAt: FOUR_PROVIDER_EXPIRES_AT,
    teamName: FOUR_PROVIDER_TEAM_NAME,
    teamLoginKey: FOUR_PROVIDER_TEAM_LOGIN_KEY,
  });
  for (const target of FOUR_PROVIDER_TARGETS) {
    await createCompositeTarget(fake.repo, {
      targetDeploymentId: targetDeploymentId(target.targetId),
      parentDeploymentId: FOUR_PROVIDER_PARENT_ID,
      targetId: target.targetId,
      targetOrdinal: target.ordinal,
      tenantId: FOUR_PROVIDER_TENANT_ID,
      problemId: FOUR_PROVIDER_PROBLEM_ID,
      provider: target.provider,
      engine: target.engine,
      entry: target.entry,
      awsAccountId: FOUR_PROVIDER_AWS_ACCOUNT_ID,
      region: FOUR_PROVIDER_REGION,
      teamName: FOUR_PROVIDER_TEAM_NAME,
      namePrefix: `tc-${FOUR_PROVIDER_PROBLEM_ID}-alpha-${target.targetId}`,
      teamLoginKey: FOUR_PROVIDER_TEAM_LOGIN_KEY,
      createdAt: FOUR_PROVIDER_NOW_ISO,
      expiresAt: FOUR_PROVIDER_EXPIRES_AT,
    });
  }
}

// ---------------------------------------------------------------------------
// Fake adapters / connection resolver — record provider call order, no cloud.
// ---------------------------------------------------------------------------

export interface FourProviderAdapters {
  readonly adapters: Record<string, { deploy: ReturnType<typeof vi.fn> }>;
  readonly callOrder: string[];
}

/** Per-provider fake adapter recording deploy call order; optionally one fails. */
export function makeFourProviderAdapters(
  failProvider?: CompositeTargetProvider,
): FourProviderAdapters {
  const callOrder: string[] = [];
  const adapters = Object.fromEntries(
    FOUR_PROVIDER_TARGETS.map((target) => [
      target.provider,
      {
        deploy: vi.fn(async () => {
          callOrder.push(target.provider);
          if (failProvider && target.provider === failProvider) {
            const err = new Error("adapter exploded") as Error & { name: string };
            err.name = "FakeAdapterError";
            throw err;
          }
          return { status: "IN_PROGRESS" as const };
        }),
      },
    ]),
  );
  return { adapters, callOrder };
}

/** Fake per-target connection resolver. AWS returns identifiers (no secrets). */
export function fakeResolveConnection(
  input: ResolveCompositeTargetConnectionInput,
): Promise<TargetConnection> {
  if (input.provider === "aws") {
    return Promise.resolve({
      provider: "aws",
      awsAccountId: input.awsAccountId,
      region: input.region,
      competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
      externalIdParameterName: "/test/tenants/tenant-acme/external-id",
    });
  }
  return Promise.resolve({ provider: input.provider, teamSlug: input.teamSlug });
}
