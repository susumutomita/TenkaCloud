import { randomUUID } from "node:crypto";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import type { CoordinationStoreDeps } from "./coordination-store.js";
import { resolveDeploymentsRepository } from "./shared.js";

// Longer than the dispatcher invocation; crashed owners cannot block a run indefinitely.
export const COORDINATION_INITIALIZATION_LEASE_MS = 30_000;
export interface CoordinationInitializationLease {
  readonly scope: CoordinationStateScope;
  readonly owner: string;
}

export async function acquireCoordinationInitialization(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
): Promise<CoordinationInitializationLease | undefined> {
  const repository = await resolveDeploymentsRepository(store);
  const owner = randomUUID();
  const nowMs = Date.now();
  const result = await repository.acquireCoordinationInitialization(
    scope,
    owner,
    nowMs,
    nowMs + COORDINATION_INITIALIZATION_LEASE_MS,
  );
  return result.outcome === "updated" ? { scope, owner } : undefined;
}

export async function releaseCoordinationInitialization(
  store: CoordinationStoreDeps,
  lease: CoordinationInitializationLease,
): Promise<void> {
  const repository = await resolveDeploymentsRepository(store);
  await repository.releaseCoordinationInitialization(lease.scope, lease.owner);
}
