/**
 * [Composite Runtime / Issues #2066, #2747] Dispatch materialized Composite targets.
 *
 * A target is ready only when every explicit dependency is COMPLETE and every declared binding can
 * be resolved from the upstream target's stored outputs. Independent ready targets are dispatched
 * concurrently. Waiting is observable as PENDING + dependency metadata; a failed dependency or a
 * missing/forbidden output fails the downstream target loudly with a target-specific, non-secret
 * reason. Re-running this function never dispatches a non-PENDING target again.
 */

import { COMPOSITE_PROVIDERS, type CompositeInputBinding } from "@tenkacloud/problem-runtime";
import type { DeploymentsCompositePort } from "../../control-data/deployments-repository.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
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

export type CompositeTargetOutcome =
  | "started"
  | "waiting"
  | "blocked"
  | "already_active"
  | "preflight_failed"
  | "dispatch_failed";

export interface CompositeTargetDispatchResult {
  readonly targetId: string;
  readonly targetDeploymentId: string;
  readonly outcome: CompositeTargetOutcome;
}

export interface CompositeDispatchResult {
  readonly parentDeploymentId: string;
  readonly targets: readonly CompositeTargetDispatchResult[];
}

export class CompositeDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeDispatchError";
  }
}

export interface CompositeDispatchDeps {
  readonly repo: CompositeDeploymentRepositoryDeps;
  readonly resolveConnection: (
    input: ResolveCompositeTargetConnectionInput,
  ) => Promise<TargetConnection>;
  /**
   * [#2747] Takes the target row as well as the runtime triple: the maintenance-tick caller
   * (`composite-ready-dispatch.ts`) dispatches targets across many parents/teams in one batch, so
   * it needs the row to resolve per-team adapter dependencies. The single-deploy caller
   * (`composite-deploy-wiring.ts`) already has the team in closure and ignores the second
   * argument — a function with fewer parameters is assignable to this type.
   */
  readonly selectAdapter: (
    runtime: { provider: string; engine: string; entry: string },
    target: CompositeTargetDeploymentRecord,
  ) => Pick<ProblemRuntimeAdapter, "deploy">;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly now: () => number;
}

function isCompositeProvider(provider: string): provider is "aws" | "gcp" | "azure" | "sakura" {
  return (COMPOSITE_PROVIDERS as readonly string[]).includes(provider);
}

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

function baseResult(target: CompositeTargetDeploymentRecord) {
  return { targetId: target.targetId, targetDeploymentId: target.jobId };
}

function terminalDependencyFailure(status: string | undefined): boolean {
  return ["FAILED", "DELETING", "DELETED", "EXPIRED", "AUTO_DELETED"].includes(status as string);
}

function normalizedDependencies(target: CompositeTargetDeploymentRecord): readonly string[] {
  return Array.isArray(target.compositeDependsOn) ? target.compositeDependsOn : [];
}

function normalizedBindings(
  target: CompositeTargetDeploymentRecord,
): Readonly<Record<string, CompositeInputBinding>> {
  const value = target.compositeInputs;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveBoundParameters(
  target: CompositeTargetDeploymentRecord,
  byId: ReadonlyMap<string, CompositeTargetDeploymentRecord>,
):
  | { readonly ok: true; readonly parameters: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string } {
  const parameters: Record<string, string> = {};
  for (const [parameterName, binding] of Object.entries(normalizedBindings(target))) {
    const upstream = byId.get(binding.fromTarget);
    if (!upstream) {
      return { ok: false, reason: `binding failed: unknown upstream ${binding.fromTarget}` };
    }
    const declaration = upstream.compositeOutputs?.[binding.output];
    if (!declaration) {
      return {
        ok: false,
        reason: `binding failed: undeclared output ${binding.fromTarget}.${binding.output}`,
      };
    }
    if (declaration.sensitivity === "sensitive" && binding.allowSensitive !== true) {
      return {
        ok: false,
        reason: `binding failed: sensitive output ${binding.fromTarget}.${binding.output} not allowed`,
      };
    }
    const value = parseStackOutputs(upstream.stackOutputs)[binding.output];
    if (typeof value !== "string") {
      return {
        ok: false,
        reason: `binding failed: missing output ${binding.fromTarget}.${binding.output}`,
      };
    }
    parameters[parameterName] = value;
  }
  return { ok: true, parameters: Object.freeze(parameters) };
}

type DependencyGateResult =
  | { readonly done: true; readonly result: CompositeTargetDispatchResult }
  | { readonly done: false };

/**
 * Resolve whether `target`'s explicit `dependsOn` graph allows it to proceed: an unknown or
 * terminally-failed dependency fails `target` loudly (`blocked`); an incomplete-but-alive
 * dependency parks it as `waiting`; every dependency COMPLETE lets the caller continue.
 */
async function evaluateDependencyGate(
  deps: CompositeDispatchDeps,
  target: CompositeTargetDeploymentRecord,
  byId: ReadonlyMap<string, CompositeTargetDeploymentRecord>,
  base: Pick<CompositeTargetDispatchResult, "targetId" | "targetDeploymentId">,
): Promise<DependencyGateResult> {
  const dependencies = normalizedDependencies(target);

  const missingDependency = dependencies.find((targetId) => !byId.has(targetId));
  if (missingDependency) {
    await markTargetFailed(deps, target.jobId, `dependency blocked: unknown ${missingDependency}`);
    return { done: true, result: { ...base, outcome: "blocked" } };
  }

  const failedDependencies = dependencies.filter((targetId) =>
    terminalDependencyFailure(byId.get(targetId)?.status),
  );
  if (failedDependencies.length > 0) {
    await markTargetFailed(
      deps,
      target.jobId,
      `dependency blocked: ${failedDependencies.sort().join(",")}`,
    );
    return { done: true, result: { ...base, outcome: "blocked" } };
  }

  if (dependencies.some((targetId) => byId.get(targetId)?.status !== "COMPLETE")) {
    return { done: true, result: { ...base, outcome: "waiting" } };
  }

  return { done: false };
}

interface ResolvedPreflight {
  readonly adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  readonly connection: TargetConnection;
  readonly problemDir: string;
}
type PreflightOutcome =
  | ({ readonly ok: true } & ResolvedPreflight)
  | { readonly ok: false; readonly result: CompositeTargetDispatchResult };

/** Resolve the provider check, connection, adapter, and problem dir a ready target needs before dispatch. */
async function runPreflight(
  deps: CompositeDispatchDeps,
  target: CompositeTargetDeploymentRecord,
  base: Pick<CompositeTargetDispatchResult, "targetId" | "targetDeploymentId">,
): Promise<PreflightOutcome> {
  if (!isCompositeProvider(target.runtimeProvider)) {
    await markTargetFailed(deps, target.jobId, "preflight failed: unknown provider");
    return { ok: false, result: { ...base, outcome: "preflight_failed" } };
  }

  let connection: TargetConnection;
  try {
    connection = await deps.resolveConnection(buildConnectionInput(target));
  } catch (error) {
    await markTargetFailed(deps, target.jobId, `preflight failed: ${nonSecretReason(error)}`);
    return { ok: false, result: { ...base, outcome: "preflight_failed" } };
  }

  let adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  try {
    adapter = deps.selectAdapter(
      {
        provider: target.runtimeProvider,
        engine: target.runtimeEngine,
        entry: target.runtimeEntry,
      },
      target,
    );
  } catch (error) {
    await markTargetFailed(deps, target.jobId, `preflight failed: ${nonSecretReason(error)}`);
    return { ok: false, result: { ...base, outcome: "preflight_failed" } };
  }

  const problemDir = deps.problemsCatalog[target.problemId];
  if (!problemDir) {
    await markTargetFailed(
      deps,
      target.jobId,
      `preflight failed: unknown problem ${target.problemId}`,
    );
    return { ok: false, result: { ...base, outcome: "preflight_failed" } };
  }

  return { ok: true, adapter, connection, problemDir };
}

async function dispatchReadyTarget(
  deps: CompositeDispatchDeps,
  target: CompositeTargetDeploymentRecord,
  byId: ReadonlyMap<string, CompositeTargetDeploymentRecord>,
): Promise<CompositeTargetDispatchResult> {
  const base = baseResult(target);

  if (target.status !== "PENDING") {
    return {
      ...base,
      outcome: target.status === "FAILED" ? "blocked" : "already_active",
    };
  }

  const gate = await evaluateDependencyGate(deps, target, byId, base);
  if (gate.done) return gate.result;

  const bound = resolveBoundParameters(target, byId);
  if (!bound.ok) {
    await markTargetFailed(deps, target.jobId, bound.reason);
    return { ...base, outcome: "blocked" };
  }

  const preflight = await runPreflight(deps, target, base);
  if (!preflight.ok) return preflight.result;
  const { adapter, connection, problemDir } = preflight;

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
      parameters: bound.parameters,
      ...(connection.provider === "aws" && connection.competitorRoleArn
        ? { competitorRoleArn: connection.competitorRoleArn }
        : {}),
      ...(connection.provider === "aws" && connection.externalIdParameterName
        ? { externalIdParameterName: connection.externalIdParameterName }
        : {}),
    });
  } catch (error) {
    await markTargetFailed(deps, target.jobId, `dispatch failed: ${nonSecretReason(error)}`);
    return { ...base, outcome: "dispatch_failed" };
  }

  return { ...base, outcome: "started" };
}

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

  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const byId = new Map(ordered.map((target) => [target.targetId, target]));

  // Promise.all preserves input ordering while allowing all ready nodes in the same wave to start
  // concurrently. Waiting/blocked nodes perform no provider call.
  const results = await Promise.all(
    ordered.map((target) => dispatchReadyTarget(deps, target, byId)),
  );
  return { parentDeploymentId, targets: results };
}
