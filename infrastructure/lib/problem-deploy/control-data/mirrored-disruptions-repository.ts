import type { DisruptionAuditRow } from "../handlers/event-handler/disruption-types.js";
import type {
  DisruptionAuditPage,
  DisruptionClaimOutcome,
  DisruptionExecutionClaimInput,
  DisruptionRecurringMutationOutcome,
  DisruptionRecurringRecord,
  DisruptionsRepository,
} from "./types.js";

/**
 * [Issue #2442 / Phase C3] DynamoDB-primary/SQL-replica equivalent for the Disruptions
 * aggregate. Idempotent claims (`claimFireIdempotency` / `claimExecutionSlot`) mirror
 * {@link MirroredCompetitorAccountsRepository.createAccount}'s contract: the replica write
 * only runs when canonical signals `claimed` (a canonical `already` means nothing new to
 * mirror — the replica already converged on the winner's earlier write, or will on its own
 * `already` outcome). Append-only writes (`appendAudit` / `putRecurringRegistry`) are
 * unconditional write-through (mirrors {@link MirroredNotificationsRepository.append}).
 * `cancelRecurringRegistry` mirrors {@link MirroredCompetitorAccountsRepository.markVerified}'s
 * conditional-write contract. Reads pass through to canonical — audit/registry rows have no
 * single-identity read-repair precedent to buy over
 * {@link MirroredProblemEndpointsRepository}'s read-passthrough style. `pruneExpired` removes
 * the SQL replica first (mirrors {@link MirroredEventsRepository.pruneExpired}).
 */
export class MirroredDisruptionsRepository implements DisruptionsRepository {
  constructor(
    private readonly canonical: DisruptionsRepository,
    private readonly replica: DisruptionsRepository,
  ) {}

  async claimFireIdempotency(draft: DisruptionAuditRow): Promise<DisruptionClaimOutcome> {
    const outcome = await this.canonical.claimFireIdempotency(draft);
    if (outcome.outcome === "claimed") await this.replica.claimFireIdempotency(draft);
    return outcome;
  }

  getFireIdempotencyRecord(
    tenantId: string,
    requestId: string,
  ): Promise<DisruptionAuditRow | undefined> {
    return this.canonical.getFireIdempotencyRecord(tenantId, requestId);
  }

  async appendAudit(record: DisruptionAuditRow): Promise<void> {
    await this.canonical.appendAudit(record);
    await this.replica.appendAudit(record);
  }

  listAuditPage(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DisruptionAuditPage> {
    return this.canonical.listAuditPage(eventId, opts);
  }

  listAuditSince(eventId: string, sinceIso: string): Promise<readonly DisruptionAuditRow[]> {
    return this.canonical.listAuditSince(eventId, sinceIso);
  }

  async putRecurringRegistry(record: DisruptionRecurringRecord): Promise<void> {
    await this.canonical.putRecurringRegistry(record);
    await this.replica.putRecurringRegistry(record);
  }

  listRecurringByEvent(
    eventId: string,
    tenantId: string,
  ): Promise<readonly DisruptionRecurringRecord[]> {
    return this.canonical.listRecurringByEvent(eventId, tenantId);
  }

  getRecurringRegistry(
    eventId: string,
    requestId: string,
  ): Promise<DisruptionRecurringRecord | undefined> {
    return this.canonical.getRecurringRegistry(eventId, requestId);
  }

  async cancelRecurringRegistry(
    eventId: string,
    requestId: string,
    tenantId: string,
    cancelledAt: string,
  ): Promise<DisruptionRecurringMutationOutcome> {
    const outcome = await this.canonical.cancelRecurringRegistry(
      eventId,
      requestId,
      tenantId,
      cancelledAt,
    );
    if (outcome.outcome === "updated") {
      await this.replica.cancelRecurringRegistry(eventId, requestId, tenantId, cancelledAt);
    }
    return outcome;
  }

  async claimExecutionSlot(input: DisruptionExecutionClaimInput): Promise<DisruptionClaimOutcome> {
    const outcome = await this.canonical.claimExecutionSlot(input);
    if (outcome.outcome === "claimed") await this.replica.claimExecutionSlot(input);
    return outcome;
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}
