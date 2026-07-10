/**
 * [Composite Runtime / Issue #2066] Start already-materialized composite target
 * jobs through the existing per-provider adapter paths.
 *
 * Composite execution only — existing single-provider `startDeployment` and its
 * API contract are untouched. This module:
 *   - loads the parent + target jobs by `parentDeploymentId` (#2061),
 *   - rejects unless the row is a composite parent and every expected target
 *     exists,
 *   - for each target in `targetOrdinal` order: resolves its provider connection
 *     (#2065), selects its adapter, and dispatches via the prepared-dispatch seam
 *     (#2064),
 *   - never stops the loop after one target fails — every independent target is
 *     attempted,
 *   - records target-level failures (PENDING → FAILED with a NON-secret reason)
 *     but never computes or updates the parent status (a later issue), and never
 *     creates or rolls back a deployment row.
 *
 * Idempotency: a target that is no longer PENDING is skipped (no adapter call),
 * so a second invocation does not re-dispatch a target its provider path has
 * already moved on. The FAILED write is conditional on PENDING for the same
 * reason. Retry of a failed target is a later issue.
 *
 * The provider connection resolver (#2065) and the adapter selector (the
 * pre-mutation runtime gate) are injected, so this orchestration is unit-testable
 * with fake adapters and never reaches a real cloud.
 */

import { COMPOSITE_PROVIDERS } from "@tenkacloud/problem-runtime";
import type { DeploymentsCompositePort } from "../../control-data/deployments-repository.js";
import type { ProblemRuntimeAdapter } from "../shared/runtime/adapter.js";
import {
  type CompositeDeploymentRepositoryDeps,
  type CompositeTargetDeploymentRecord,
  getCompositeParent,
  listCompositeTargets,
} from "./composite-repository.js";
import type {
  ResolveCompositeTargetConnectionInput,
  TargetConnection,
} from "./composite-target-connection.js";
import { slugify } from "./naming.js";
import { dispatchPreparedDeployment } from "./prepared-dispatch.js";
import { resolveDeploymentsRepository } from "./shared.js";

export type CompositeTargetOutcome = "started" | "preflight_failed" | "dispatch_failed";

export interface CompositeTargetDispatchResult {
  readonly targetId: string;
  readonly targetDeploymentId: string;
  readonly outcome: CompositeTargetOutcome;
}

export interface CompositeDispatchResult {
  readonly parentDeploymentId: string;
  readonly targets: readonly CompositeTargetDispatchResult[];
}

/** Raised when the parent is missing / not composite, or targets are incomplete. */
export class CompositeDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeDispatchError";
  }
}

export interface CompositeDispatchDeps {
  /** Repository deps (injected ddb client + table name) for loads + FAILED writes. */
  readonly repo: CompositeDeploymentRepositoryDeps;
  /** Resolve a target's provider connection (#2065). Injected for testability. */
  readonly resolveConnection: (
    input: ResolveCompositeTargetConnectionInput,
  ) => Promise<TargetConnection>;
  /** Select the runtime adapter for a target (the pre-mutation gate). Injected. */
  readonly selectAdapter: (runtime: {
    provider: string;
    engine: string;
    entry: string;
  }) => Pick<ProblemRuntimeAdapter, "deploy">;
  /** problemId → problemDir (the synth-baked catalog). */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /** Clock for `updatedAt` on FAILED writes (epoch ms). */
  readonly now: () => number;
}

function isCompositeProvider(provider: string): provider is "aws" | "gcp" | "azure" | "sakura" {
  return (COMPOSITE_PROVIDERS as readonly string[]).includes(provider);
}

/** Class name only — never an error message, which could carry provider detail. */
function nonSecretReason(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown error";
}

function buildConnectionInput(
  target: CompositeTargetDeploymentRecord,
): ResolveCompositeTargetConnectionInput {
  if (target.runtimeProvider === "aws") {
    return {
      provider: "aws",
      tenantId: target.tenantId,
      awsAccountId: target.awsAccountId,
      region: target.region,
    };
  }
  return {
    provider: target.runtimeProvider as "gcp" | "azure" | "sakura",
    tenantId: target.tenantId,
    teamSlug: slugify(target.teamName),
  };
}

/**
 * Mark a target PENDING → FAILED with a non-secret reason. Conditional on PENDING
 * so it never clobbers a status the provider path has already advanced, and so a
 * concurrent / repeat call is idempotent.
 *
 * [Issue #2441 / Phase B2] `failCompositeTargetIfPending` folds the CCF into a
 * `conflict` outcome instead of throwing — discarding it here is the
 * byte-identical no-op the pre-seam CCF-swallow produced.
 */
async function markTargetFailed(
  deps: CompositeDispatchDeps,
  targetDeploymentId: string,
  reason: string,
): Promise<void> {
  const repository: DeploymentsCompositePort = await resolveDeploymentsRepository(deps.repo);
  await repository.failCompositeTargetIfPending(
    targetDeploymentId,
    reason,
    new Date(deps.now()).toISOString(),
  );
}

async function dispatchOneTarget(
  deps: CompositeDispatchDeps,
  target: CompositeTargetDeploymentRecord,
): Promise<CompositeTargetDispatchResult> {
  const base = { targetId: target.targetId, targetDeploymentId: target.jobId };

  // Not PENDING → not dispatchable. No adapter call, no FAILED write (so a second
  // invocation never re-dispatches a target the provider path has advanced).
  if (target.status !== "PENDING") {
    return { ...base, outcome: "dispatch_failed" };
  }

  if (!isCompositeProvider(target.runtimeProvider)) {
    await markTargetFailed(deps, target.jobId, `preflight failed: unknown provider`);
    return { ...base, outcome: "preflight_failed" };
  }

  let connection: TargetConnection;
  try {
    connection = await deps.resolveConnection(buildConnectionInput(target));
  } catch (err) {
    await markTargetFailed(deps, target.jobId, `preflight failed: ${nonSecretReason(err)}`);
    return { ...base, outcome: "preflight_failed" };
  }

  let adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  try {
    adapter = deps.selectAdapter({
      provider: target.runtimeProvider,
      engine: target.runtimeEngine,
      entry: target.runtimeEntry,
    });
  } catch (err) {
    await markTargetFailed(deps, target.jobId, `preflight failed: ${nonSecretReason(err)}`);
    return { ...base, outcome: "preflight_failed" };
  }

  const problemDir = deps.problemsCatalog[target.problemId];
  if (!problemDir) {
    await markTargetFailed(
      deps,
      target.jobId,
      `preflight failed: unknown problem ${target.problemId}`,
    );
    return { ...base, outcome: "preflight_failed" };
  }

  try {
    await dispatchPreparedDeployment({
      adapter,
      jobId: target.jobId,
      tenantId: target.tenantId,
      problemId: target.problemId,
      problemDir,
      teamSlug: slugify(target.teamName),
      namePrefix: target.namePrefix,
      region: target.region,
      awsAccountId: target.awsAccountId,
      ...(connection.provider === "aws" && connection.competitorRoleArn
        ? { competitorRoleArn: connection.competitorRoleArn }
        : {}),
      ...(connection.provider === "aws" && connection.externalIdParameterName
        ? { externalIdParameterName: connection.externalIdParameterName }
        : {}),
    });
  } catch (err) {
    await markTargetFailed(deps, target.jobId, `dispatch failed: ${nonSecretReason(err)}`);
    return { ...base, outcome: "dispatch_failed" };
  }

  return { ...base, outcome: "started" };
}

/**
 * Dispatch every target of a stored composite deployment through its existing
 * adapter path. Returns one outcome per target in `targetOrdinal` order.
 */
export async function dispatchCompositeDeployment(
  deps: CompositeDispatchDeps,
  parentDeploymentId: string,
): Promise<CompositeDispatchResult> {
  const parent = await getCompositeParent(deps.repo, parentDeploymentId);
  if (!parent) {
    throw new CompositeDispatchError(
      `composite parent ${parentDeploymentId} not found or not a composite parent`,
    );
  }

  const targets = await listCompositeTargets(deps.repo, parentDeploymentId);
  if (targets.length !== parent.targetCount) {
    throw new CompositeDispatchError(
      `composite parent ${parentDeploymentId} expects ${parent.targetCount} targets but found ${targets.length}`,
    );
  }

  // listCompositeTargets already returns GSI3 ordinal order; sort defensively.
  const ordered = [...targets].sort((a, b) => a.targetOrdinal - b.targetOrdinal);

  const results: CompositeTargetDispatchResult[] = [];
  for (const target of ordered) {
    results.push(await dispatchOneTarget(deps, target));
  }
  return { parentDeploymentId, targets: results };
}
