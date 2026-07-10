import type { ProblemEndpointRecord, ProblemEndpointsRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C1] DynamoDB-primary/SQL-replica equivalent for the
 * ProblemEndpoints aggregate. Writes commit to canonical DynamoDB first and
 * only apply to the replica when the canonical write succeeds (unconditional
 * writes here — there is no CCF-style outcome to gate on, unlike
 * {@link MirroredDeploymentsRepository}). Reads pass through to canonical: a
 * (tenant, team, problem) override list is small (a handful of slots) and has
 * no cursor / scan-page state to reconcile, so there is nothing for read-repair
 * to buy over the Events/Teams style (mirrors
 * {@link MirroredDeploymentsRepository}'s read-passthrough, not
 * {@link MirroredTeamsRepository}'s read-repair).
 */
export class MirroredProblemEndpointsRepository implements ProblemEndpointsRepository {
  constructor(
    private readonly canonical: ProblemEndpointsRepository,
    private readonly replica: ProblemEndpointsRepository,
  ) {}

  queryOverrides(
    tenantId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly ProblemEndpointRecord[]> {
    return this.canonical.queryOverrides(tenantId, teamId, problemId);
  }

  async putOverride(record: ProblemEndpointRecord): Promise<void> {
    await this.canonical.putOverride(record);
    await this.replica.putOverride(record);
  }

  async deleteOverride(
    tenantId: string,
    teamId: string,
    problemId: string,
    slot: string,
  ): Promise<void> {
    await this.canonical.deleteOverride(tenantId, teamId, problemId, slot);
    await this.replica.deleteOverride(tenantId, teamId, problemId, slot);
  }
}
