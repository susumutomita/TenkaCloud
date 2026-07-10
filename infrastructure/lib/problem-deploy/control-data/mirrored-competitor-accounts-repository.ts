/**
 * [Issue #2527 Slice 3] Mirror (DynamoDB-canonical + SQL-replica) adapter for the
 * competitor-accounts aggregate — extracted verbatim from the former all-aggregate
 * `mirrored-repositories.ts`, which now re-exports this class as a barrel.
 * Mirror policy: writes commit to canonical first and reach the replica only on
 * a successful canonical outcome; reads/cursors are canonical-only unless the
 * class documents read-repair; a replica failure throws (fail loud).
 */

import type { CompetitorAccountItem } from "../handlers/competitor-accounts-handler/types.js";
import type {
  CompetitorAccountMutationOutcome,
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
  CreateCompetitorAccountOutcome,
} from "./types.js";

/**
 * [Issue #2442 / Phase C2] DynamoDB-primary/SQL-replica equivalent for the
 * CompetitorAccounts aggregate. Conditional writes commit to canonical
 * DynamoDB first; the replica only applies when the canonical outcome
 * signals success (`created` / `updated`), mirroring
 * {@link MirroredEventsRepository}'s conditional-write contract. Reads pass
 * through to canonical: the tenant's account list is small (no cursor / scan
 * state to reconcile) and `forEachCompetitorAccountPage` is a full-table
 * audit sweep, so there is nothing for read-repair to buy over
 * {@link MirroredProblemEndpointsRepository}'s read-passthrough style.
 */
export class MirroredCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(
    private readonly canonical: CompetitorAccountsRepository,
    private readonly replica: CompetitorAccountsRepository,
  ) {}

  async createAccount(record: CompetitorAccountRecord): Promise<CreateCompetitorAccountOutcome> {
    const outcome = await this.canonical.createAccount(record);
    if (outcome.outcome === "created") await this.replica.createAccount(record);
    return outcome;
  }

  listAccounts(tenantId: string): Promise<readonly CompetitorAccountRecord[]> {
    return this.canonical.listAccounts(tenantId);
  }

  getAccount(tenantId: string, awsAccountId: string): Promise<CompetitorAccountRecord | undefined> {
    return this.canonical.getAccount(tenantId, awsAccountId);
  }

  async markVerified(
    tenantId: string,
    awsAccountId: string,
    verifiedAt: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const outcome = await this.canonical.markVerified(tenantId, awsAccountId, verifiedAt);
    if (outcome.outcome === "updated") {
      await this.replica.markVerified(tenantId, awsAccountId, verifiedAt);
    }
    return outcome;
  }

  async deleteAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const outcome = await this.canonical.deleteAccount(tenantId, awsAccountId);
    if (outcome.outcome === "updated") await this.replica.deleteAccount(tenantId, awsAccountId);
    return outcome;
  }

  hasRemainingAccounts(tenantId: string): Promise<boolean> {
    return this.canonical.hasRemainingAccounts(tenantId);
  }

  forEachCompetitorAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountItem>[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachCompetitorAccountPage(onPage);
  }
}
