/**
 * [Composite Runtime / Issue #2081] Offline-safe Composite acceptance harness suite.
 *
 * Drives the FULL Composite parent/child lifecycle AND the four required
 * failure-injection classes through the real, already-merged Composite modules —
 * composed by `CompositeAcceptanceHarness` — over an in-memory DynamoDB double and
 * injected fake provider transports. NO real cloud, NO network, NO provider SDK
 * credentials: this is exactly the part of the live-acceptance task that CI can
 * verify (CI has no cloud accounts and never deploys; the real four-provider
 * matrix is the env-guarded live runner + the maintainer runbook).
 *
 * The orchestration under test is production code (deploy routing, materialization,
 * ordered dispatch, status aggregation/reconciliation, namespaced outputs,
 * composite-probe scoring, teardown fan-out, teardown completion). Only the
 * provider transport (deploy adapter / connection resolver / per-target teardown /
 * HTTPS probe) and the persistence client are doubles.
 *
 * The four-provider fixture (aws-api → gcp-worker → azure-edge → sakura-service) is
 * reused from the #2079 contract helpers so the acceptance flow asserts against the
 * SAME canonical shape the contract suite pins.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptanceTarget,
  acceptanceTargetDeploymentId,
  type CompositeAcceptanceConfig,
  CompositeAcceptanceHarness,
  type ProviderTransport,
} from "../../lib/problem-deploy/handlers/acceptance/composite-acceptance-harness";
import {
  type CompositeDeploymentRepositoryDeps,
  getCompositeParent,
  listCompositeTargets,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import type {
  ResolveCompositeTargetConnectionInput,
  TargetConnection,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-connection";
import type { TeardownOutcome } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import type { DeploymentStatus } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import type { CompositeParentReconcileDeps } from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler";
import type { CompositeProbeFn } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/composite-probe";
import type { CompositeProbeScoringMetadata } from "../../lib/utils/scoring-metadata";
import { parseScoringMetadata } from "../../lib/utils/scoring-metadata";
import {
  FOUR_PROVIDER_AWS_ACCOUNT_ID,
  FOUR_PROVIDER_NOW_MS,
  FOUR_PROVIDER_PARENT_ID,
  FOUR_PROVIDER_PROBLEM_DIR,
  FOUR_PROVIDER_PROBLEM_ID,
  FOUR_PROVIDER_REGION,
  FOUR_PROVIDER_RUNTIME,
  FOUR_PROVIDER_SCORING,
  FOUR_PROVIDER_TARGET_IDS,
  FOUR_PROVIDER_TARGETS,
  FOUR_PROVIDER_TEAM_LOGIN_KEY,
  FOUR_PROVIDER_TEAM_NAME,
  FOUR_PROVIDER_TENANT_ID,
  targetUrl,
} from "./composite-four-provider.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

// ---------------------------------------------------------------------------
// A secret-bearing connection store, so the redaction assertions are meaningful:
// the production preflight returns only identifiers, never these raw secrets.
// ---------------------------------------------------------------------------

const AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/Deploy";
const AWS_EXTERNAL_ID_PARAM = "/test/tenants/tenant-acme/external-id";
/** A fake static credential value that MUST NOT leak anywhere. */
const SECRET_TOKEN = "SECRET-azure-client-secret-AKIAEXFILTRATE";

const ACCEPTANCE_TARGETS: readonly AcceptanceTarget[] = FOUR_PROVIDER_TARGETS.map((t) => ({
  targetId: t.targetId,
  ordinal: t.ordinal,
  provider: t.provider,
  engine: t.engine,
  entry: t.entry,
  outputKey: t.outputKey,
  url: targetUrl(t.targetId),
}));

const SCORING = parseScoringMetadata(FOUR_PROVIDER_SCORING) as CompositeProbeScoringMetadata;

// ---------------------------------------------------------------------------
// In-memory DynamoDB double — Put / Get / Query(GSI3) / Update / Scan. Mirrors the
// established composite harness so the real repository + reconcilers run over
// genuine persisted state with no cloud and no provider SDK credentials.
// ---------------------------------------------------------------------------

const rowKey = (pk: unknown, sk: unknown): string => `${String(pk)}|${String(sk)}`;

function conditionalCheckFailed(): Error & { name: string } {
  const err = new Error("conditional check failed") as Error & { name: string };
  err.name = "ConditionalCheckFailedException";
  return err;
}

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

function handleQuery(cmd: QueryCommand, store: Map<string, Record<string, unknown>>): object {
  const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
  const matched = [...store.values()].filter((r) => r.GSI3PK === pk);
  matched.sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
  return { Items: matched.map((r) => ({ ...r })) };
}

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

interface PersistenceDouble {
  readonly repo: CompositeDeploymentRepositoryDeps;
  readonly reconcileDeps: CompositeParentReconcileDeps;
  readonly store: Map<string, Record<string, unknown>>;
  readonly readStatus: (deploymentId: string) => DeploymentStatus | undefined;
  readonly setStatus: (deploymentId: string, status: DeploymentStatus) => void;
  readonly setOutputs: (deploymentId: string, raw: string) => void;
}

function makePersistence(): PersistenceDouble {
  const store = new Map<string, Record<string, unknown>>();
  const send = vi.fn(async (cmd: unknown) => dispatchCommand(cmd, store));
  const repo: CompositeDeploymentRepositoryDeps = { ddb: { send }, tableName: "TestDeployments" };
  return {
    repo,
    reconcileDeps: {
      runtime: makeTestControlDataRuntime(),
      ddb: { send },
      deploymentsTableName: "TestDeployments",
    },
    store,
    readStatus: (deploymentId) =>
      store.get(`DEPLOYMENT#${deploymentId}|META`)?.status as DeploymentStatus | undefined,
    setStatus: (deploymentId, status) => {
      const row = store.get(`DEPLOYMENT#${deploymentId}|META`);
      if (row) row.status = status;
    },
    setOutputs: (deploymentId, raw) => {
      const row = store.get(`DEPLOYMENT#${deploymentId}|META`);
      if (row) row.stackOutputs = raw;
    },
  };
}

// ---------------------------------------------------------------------------
// Provider transport doubles — record call order, optionally inject a failure.
// AWS connection returns identifiers; non-AWS returns only a teamSlug (never the
// stored secret). The probe / adapter / teardown are healthy by default.
// ---------------------------------------------------------------------------

interface TransportOptions {
  readonly dispatchFailProvider?: AcceptanceTarget["provider"];
  readonly preflightFailProvider?: AcceptanceTarget["provider"];
  readonly probeFailTargetId?: string;
  readonly teardownFailTargetId?: string;
}

interface TransportHandle {
  readonly transport: ProviderTransport;
  readonly deployOrder: string[];
  readonly teardownOrder: string[];
}

function makeTransport(options: TransportOptions = {}): TransportHandle {
  const deployOrder: string[] = [];
  const teardownOrder: string[] = [];

  const adapter = {
    deploy: vi.fn(async (input: { problemId: string }) => {
      // The dispatch path derives a single adapter per call; record by problemId.
      deployOrder.push(input.problemId);
      return { status: "IN_PROGRESS" as const };
    }),
  };

  const resolveConnection = vi.fn(
    async (input: ResolveCompositeTargetConnectionInput): Promise<TargetConnection> => {
      const provider = input.provider;
      if (options.preflightFailProvider && provider === options.preflightFailProvider) {
        const err = new Error("no valid connection") as Error & { name: string };
        err.name = "MissingTargetConnectionError";
        throw err;
      }
      if (provider === "aws") {
        return {
          provider: "aws",
          awsAccountId: input.awsAccountId,
          region: input.region,
          competitorRoleArn: AWS_ROLE_ARN,
          externalIdParameterName: AWS_EXTERNAL_ID_PARAM,
        };
      }
      return { provider, teamSlug: input.teamSlug };
    },
  );

  const teardownTarget = vi.fn(async (targetDeploymentId: string): Promise<TeardownOutcome> => {
    teardownOrder.push(targetDeploymentId);
    if (
      options.teardownFailTargetId &&
      targetDeploymentId === acceptanceTargetDeploymentId(options.teardownFailTargetId)
    ) {
      const err = new Error("teardown transport exploded") as Error & { name: string };
      err.name = "FakeTeardownError";
      throw err;
    }
    return { kind: "accepted", previousStatus: "COMPLETE" };
  });

  const probe: CompositeProbeFn = vi.fn(async (url: string) => ({
    ok: !(options.probeFailTargetId && url.includes(options.probeFailTargetId)),
  }));

  // The dispatch path selects ONE adapter per target. To honor a per-provider
  // dispatch failure we wrap deploy so a chosen provider throws on its turn.
  if (options.dispatchFailProvider) {
    adapter.deploy.mockImplementation(async (input: { problemId: string; namePrefix: string }) => {
      deployOrder.push(input.problemId);
      // namePrefix carries the targetId suffix, so a per-provider fail is keyed off it.
      const failing = ACCEPTANCE_TARGETS.find((t) => t.provider === options.dispatchFailProvider);
      if (failing && input.namePrefix.endsWith(failing.targetId)) {
        const err = new Error("adapter exploded") as Error & { name: string };
        err.name = "FakeAdapterError";
        throw err;
      }
      return { status: "IN_PROGRESS" as const };
    });
  }

  return {
    transport: { adapter, resolveConnection, teardownTarget, probe },
    deployOrder,
    teardownOrder,
  };
}

function makeConfig(
  persistence: PersistenceDouble,
  transport: ProviderTransport,
): CompositeAcceptanceConfig {
  return {
    parentDeploymentId: FOUR_PROVIDER_PARENT_ID,
    tenantId: FOUR_PROVIDER_TENANT_ID,
    problemId: FOUR_PROVIDER_PROBLEM_ID,
    problemDir: FOUR_PROVIDER_PROBLEM_DIR,
    teamName: FOUR_PROVIDER_TEAM_NAME,
    teamLoginKey: FOUR_PROVIDER_TEAM_LOGIN_KEY,
    awsAccountId: FOUR_PROVIDER_AWS_ACCOUNT_ID,
    region: FOUR_PROVIDER_REGION,
    nowMs: FOUR_PROVIDER_NOW_MS,
    descriptor: FOUR_PROVIDER_RUNTIME,
    scoring: SCORING,
    targets: ACCEPTANCE_TARGETS,
    transport,
    repo: persistence.repo,
    reconcileDeps: persistence.reconcileDeps,
    readStatus: persistence.readStatus,
    setStatus: persistence.setStatus,
    setOutputs: persistence.setOutputs,
  };
}

/** Build a harness wired to a fresh persistence double + a transport with options. */
function makeHarness(options: TransportOptions = {}): {
  harness: CompositeAcceptanceHarness;
  persistence: PersistenceDouble;
  handle: TransportHandle;
} {
  const persistence = makePersistence();
  const handle = makeTransport(options);
  const harness = new CompositeAcceptanceHarness(makeConfig(persistence, handle.transport));
  return { harness, persistence, handle };
}

/** Serialize every record + log so a redaction assertion can sweep the whole trace. */
function serializeTrace(
  harness: CompositeAcceptanceHarness,
  persistence: PersistenceDouble,
): string {
  const rows = [...persistence.store.values()];
  return JSON.stringify({ rows, logs: harness.capturedLogs() });
}

describe("CompositeAcceptanceHarness: full happy-path lifecycle", () => {
  let ctx: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    ctx = makeHarness();
  });

  it("should verify every per-target connection before any deploy", async () => {
    const results = await ctx.harness.verifyConnections();
    expect(results.map((r) => r.targetId)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    for (const result of results) {
      expect(result.ok, `provider=${result.provider} preflight should pass`).toBe(true);
    }
    expect(ctx.handle.transport.resolveConnection).toHaveBeenCalledTimes(4);
  });

  it("should start the composite deploy materializing one parent and four target rows", async () => {
    const { parentDeploymentId, dispatch } = await ctx.harness.startDeploy();
    expect(parentDeploymentId).toBe(FOUR_PROVIDER_PARENT_ID);

    const parent = await getCompositeParent(ctx.persistence.repo, FOUR_PROVIDER_PARENT_ID);
    expect(parent?.runtimeKind).toBe("composite");
    expect(parent?.targetCount).toBe(4);

    const targets = await listCompositeTargets(ctx.persistence.repo, FOUR_PROVIDER_PARENT_ID);
    expect(targets.map((t) => t.targetId)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    expect(dispatch.targets.map((t) => t.outcome)).toEqual([
      "started",
      "started",
      "started",
      "started",
    ]);
  });

  it("should progress the parent PENDING to IN_PROGRESS then COMPLETE as targets complete", async () => {
    await ctx.harness.startDeploy();

    expect(await ctx.harness.reconcileParentStatus()).toBe("PENDING");

    ctx.persistence.setStatus(acceptanceTargetDeploymentId("aws-api"), "IN_PROGRESS");
    expect(await ctx.harness.reconcileParentStatus()).toBe("IN_PROGRESS");

    for (const target of ACCEPTANCE_TARGETS) ctx.harness.completeTarget(target);
    expect(await ctx.harness.reconcileParentStatus()).toBe("COMPLETE");
    expect(ctx.persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("COMPLETE");
  });

  it("should expose outputs under each targetId namespace without flattening collisions", async () => {
    await ctx.harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) ctx.harness.completeTarget(target);
    await ctx.harness.reconcileParentStatus();

    const outputs = await ctx.harness.collectOutputs();
    expect(Object.keys(outputs)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    for (const target of ACCEPTANCE_TARGETS) {
      expect(
        outputs[target.targetId].Url,
        `targetId=${target.targetId} must keep its own namespaced Url output`,
      ).toBe(target.url);
    }
  });

  it("should award full composite points only when all four probes succeed", async () => {
    await ctx.harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) ctx.harness.completeTarget(target);
    await ctx.harness.reconcileParentStatus();

    const result = await ctx.harness.score();
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(FOUR_PROVIDER_SCORING.pointsAllOk);
    expect(result.data.failures).toEqual([]);
    expect(ctx.handle.transport.probe).toHaveBeenCalledTimes(4);
  });

  it("should tear down every target and finalize the parent to DELETED", async () => {
    await ctx.harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) ctx.harness.completeTarget(target);
    await ctx.harness.reconcileParentStatus();

    const teardown = await ctx.harness.requestTeardown();
    expect(ctx.persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("DELETING");
    expect(teardown.targets.map((t) => t.outcome)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(ctx.handle.teardownOrder).toEqual([
      "t-aws-api",
      "t-gcp-worker",
      "t-azure-edge",
      "t-sakura-service",
    ]);

    // The teardown transport moves each target deleted-like; reconcile finalizes.
    for (const target of ACCEPTANCE_TARGETS) {
      ctx.persistence.setStatus(acceptanceTargetDeploymentId(target.targetId), "DELETED");
    }
    expect(await ctx.harness.reconcileTeardown()).toBe("DELETED");
    expect(ctx.persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("DELETED");
  });

  it("should never expose any credential or secret in records or logs", async () => {
    await ctx.harness.verifyConnections();
    await ctx.harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) ctx.harness.completeTarget(target);
    await ctx.harness.reconcileParentStatus();
    await ctx.harness.score();
    await ctx.harness.requestTeardown();

    const trace = serializeTrace(ctx.harness, ctx.persistence);
    expect(trace).not.toContain(SECRET_TOKEN);
    expect(trace).not.toContain(AWS_ROLE_ARN);
    expect(trace).not.toContain(AWS_EXTERNAL_ID_PARAM);
    expect(trace).not.toContain("competitorRoleArn");
    expect(trace.toLowerCase()).not.toContain("client-secret");
  });
});

describe("CompositeAcceptanceHarness: failure injection — connection preflight failure", () => {
  it("should surface a retryable per-target reason when the GCP preflight fails", async () => {
    const { harness } = makeHarness({ preflightFailProvider: "gcp" });
    const results = await harness.verifyConnections();

    const gcp = results.find((r) => r.targetId === "gcp-worker");
    expect(gcp?.ok).toBe(false);
    expect(gcp?.reason).toBe("MissingTargetConnectionError");
    expect(gcp?.retryable).toBe(true);

    // Every other provider's preflight still passed — the failure is isolated.
    for (const id of ["aws-api", "azure-edge", "sakura-service"]) {
      expect(results.find((r) => r.targetId === id)?.ok, `targetId=${id} should still pass`).toBe(
        true,
      );
    }
  });

  it("should keep the preflight failure reason free of any secret detail", async () => {
    const { harness } = makeHarness({ preflightFailProvider: "azure" });
    const results = await harness.verifyConnections();
    const azure = results.find((r) => r.targetId === "azure-edge");
    // Class name only — never an exfiltratable message.
    expect(azure?.reason).not.toContain("connection");
    expect(JSON.stringify(harness.capturedLogs())).not.toContain(SECRET_TOKEN);
  });
});

describe("CompositeAcceptanceHarness: failure injection — dispatch failure", () => {
  it("should record a dispatch_failed outcome and FAIL the parent while preserving other targets", async () => {
    const { harness, persistence, handle } = makeHarness({ dispatchFailProvider: "gcp" });

    const { dispatch } = await harness.startDeploy();

    // Every independent target was still attempted — the loop never short-circuits.
    expect(handle.deployOrder).toHaveLength(4);
    const gcp = dispatch.targets.find((t) => t.targetId === "gcp-worker");
    expect(gcp?.outcome, "gcp-worker dispatch should be dispatch_failed").toBe("dispatch_failed");

    // The failing target row is FAILED with a NON-secret reason (class name only).
    expect(persistence.readStatus(acceptanceTargetDeploymentId("gcp-worker"))).toBe("FAILED");
    const gcpRow = persistence.store.get("DEPLOYMENT#t-gcp-worker|META");
    expect(String(gcpRow?.failureReason)).not.toContain("exploded");

    // The other three targets are untouched (still PENDING).
    for (const id of ["aws-api", "azure-edge", "sakura-service"]) {
      expect(
        persistence.readStatus(acceptanceTargetDeploymentId(id)),
        `targetId=${id} must be preserved when gcp-worker fails`,
      ).toBe("PENDING");
    }

    // Any FAILED target aggregates the parent to FAILED.
    expect(await harness.reconcileParentStatus()).toBe("FAILED");
  });
});

describe("CompositeAcceptanceHarness: failure injection — mid-flight target status failure", () => {
  it("should aggregate the parent to FAILED when one in-flight target turns FAILED", async () => {
    const { harness, persistence } = makeHarness();
    await harness.startDeploy();

    // Two targets complete, one is in flight, one fails mid-flight (status injection).
    persistence.setStatus(acceptanceTargetDeploymentId("aws-api"), "COMPLETE");
    persistence.setStatus(acceptanceTargetDeploymentId("gcp-worker"), "COMPLETE");
    persistence.setStatus(acceptanceTargetDeploymentId("azure-edge"), "IN_PROGRESS");
    persistence.setStatus(acceptanceTargetDeploymentId("sakura-service"), "FAILED");

    expect(await harness.reconcileParentStatus()).toBe("FAILED");
    expect(persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("FAILED");
  });

  it("should withhold composite scoring when the parent is not COMPLETE", async () => {
    const { harness, persistence, handle } = makeHarness();
    await harness.startDeploy();
    persistence.setStatus(acceptanceTargetDeploymentId("sakura-service"), "FAILED");
    await harness.reconcileParentStatus();

    const result = await harness.score();
    expect(result.notReady).toBe(true);
    expect(result.success).toBe(false);
    expect(handle.transport.probe).not.toHaveBeenCalled();
  });
});

describe("CompositeAcceptanceHarness: failure injection — teardown failure", () => {
  it("should isolate a single target teardown failure and not finalize the parent", async () => {
    const { harness, persistence, handle } = makeHarness({
      teardownFailTargetId: "azure-edge",
    });
    await harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) harness.completeTarget(target);
    await harness.reconcileParentStatus();

    const teardown = await harness.requestTeardown();
    // The fan-out attempted every target despite the azure failure.
    expect(handle.teardownOrder).toHaveLength(4);
    const azure = teardown.targets.find((t) => t.targetId === "azure-edge");
    expect(azure?.outcome, "failed azure teardown should be reported failed").toBe("failed");

    // Parent is DELETING but cannot finalize: azure never reached a deleted-like state.
    expect(persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("DELETING");
    persistence.setStatus(acceptanceTargetDeploymentId("aws-api"), "DELETED");
    persistence.setStatus(acceptanceTargetDeploymentId("gcp-worker"), "DELETED");
    persistence.setStatus(acceptanceTargetDeploymentId("sakura-service"), "DELETED");
    expect(await harness.reconcileTeardown()).toBe("DELETING");
    expect(persistence.readStatus(FOUR_PROVIDER_PARENT_ID)).toBe("DELETING");
  });

  it("should keep a failed teardown reason free of provider secret detail in logs", async () => {
    const { harness } = makeHarness({ teardownFailTargetId: "azure-edge" });
    await harness.startDeploy();
    for (const target of ACCEPTANCE_TARGETS) harness.completeTarget(target);
    await harness.reconcileParentStatus();
    await harness.requestTeardown();

    const logs = JSON.stringify(harness.capturedLogs());
    expect(logs).not.toContain("exploded");
    expect(logs).not.toContain(SECRET_TOKEN);
  });
});
