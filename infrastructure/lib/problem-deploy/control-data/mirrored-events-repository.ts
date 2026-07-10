import type { ProgressionGateConfig } from "../handlers/shared/progression-gate.js";
import type {
  ClearProgressionGateOutcome,
  CreateEventWithTeamsOutcome,
  EventMutationOutcome,
  EventRecord,
  EventSchedulePatch,
  EventScoringMeta,
  EventsPage,
  EventsRepository,
  ScheduleFiredKind,
  TeamRecord,
} from "./types.js";

function sameEventRecord(left: EventRecord, right: EventRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Phase-1 strangler repository.
 *
 * DynamoDB remains canonical so rollback is one flag flip. Writes commit there
 * before Turso; reads reconcile the SQL copy and return the reconciled SQL row.
 * Deletes and TTL pruning remove SQL first, which prevents a failed operation
 * from creating data that exists only in Turso.
 */
export class MirroredEventsRepository implements EventsRepository {
  constructor(
    private readonly canonical: EventsRepository,
    private readonly replica: EventsRepository,
  ) {}

  async getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getEvent(tenantId, eventId),
      this.replica.getEvent(tenantId, eventId),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteEvent(eventId);
      return undefined;
    }
    if (!replica || !sameEventRecord(canonical, replica)) {
      await this.replica.putEvent(canonical);
    }
    return (await this.replica.getEvent(tenantId, eventId)) ?? canonical;
  }

  async putEvent(record: EventRecord): Promise<void> {
    await this.canonical.putEvent(record);
    await this.replica.putEvent(record);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.replica.deleteEvent(eventId);
    await this.canonical.deleteEvent(eventId);
  }

  async listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]> {
    const [canonical, replica] = await Promise.all([
      this.canonical.listEventsByTenant(tenantId),
      this.replica.listEventsByTenant(tenantId),
    ]);
    const canonicalById = new Map(canonical.map((record) => [record.eventId, record]));
    const replicaById = new Map(replica.map((record) => [record.eventId, record]));
    await Promise.all([
      ...canonical
        .filter((record) => {
          const mirrored = replicaById.get(record.eventId);
          return !mirrored || !sameEventRecord(record, mirrored);
        })
        .map((record) => this.replica.putEvent(record)),
      ...replica
        .filter((record) => !canonicalById.has(record.eventId))
        .map((record) => this.replica.deleteEvent(record.eventId)),
    ]);
    return this.replica.listEventsByTenant(tenantId);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }

  // ---------------------------------------------------------------------------
  // [Issue #2438 / Phase A3] List/scan/batch/count reads. These are read-only
  // aggregate views (a UI page, a reconciler sweep, a scoring batch, a count) —
  // unlike `getEvent` / `listEventsByTenant`, they have no per-record identity
  // to read-repair against, so the canonical (DynamoDB) result is returned
  // directly. Replica drift, if any, self-heals through the point-read /
  // tenant-list paths above the next time each record is touched.
  // ---------------------------------------------------------------------------

  async listEventsPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<EventsPage> {
    return this.canonical.listEventsPage(tenantId, opts);
  }

  async listEventsByStatus(statuses: readonly string[]): Promise<readonly EventRecord[]> {
    return this.canonical.listEventsByStatus(statuses);
  }

  async batchGetEvents(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, EventScoringMeta>> {
    return this.canonical.batchGetEvents(eventIds);
  }

  async countEventsByTenant(tenantId: string): Promise<number> {
    return this.canonical.countEventsByTenant(tenantId);
  }

  // ---------------------------------------------------------------------------
  // [Issue #2437] Conditional writes: canonical (DynamoDB) first, its outcome is
  // adopted, and the SAME domain operation is applied to the replica only when
  // the canonical write succeeded. A replica failure throws (fail loudly — no
  // silent fallback); a replica outcome mismatch from drift is left to the
  // read-repair paths above (every read reconciles the replica from canonical).
  // ---------------------------------------------------------------------------

  /** Adopt the canonical outcome; run the replica op only on a canonical success. */
  private async mirrorWrite<T extends { readonly outcome: string }>(
    canonicalOutcome: T,
    applyToReplica: () => Promise<unknown>,
  ): Promise<T> {
    if (canonicalOutcome.outcome === "updated" || canonicalOutcome.outcome === "created") {
      await applyToReplica();
    }
    return canonicalOutcome;
  }

  async endEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.endEvent(tenantId, eventId, at), () =>
      this.replica.endEvent(tenantId, eventId, at),
    );
  }

  async lockScoring(
    tenantId: string,
    eventId: string,
    lockedBy: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.lockScoring(tenantId, eventId, lockedBy, at), () =>
      this.replica.lockScoring(tenantId, eventId, lockedBy, at),
    );
  }

  async unlockScoring(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.unlockScoring(tenantId, eventId, at), () =>
      this.replica.unlockScoring(tenantId, eventId, at),
    );
  }

  async archiveEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.archiveEvent(tenantId, eventId, at), () =>
      this.replica.archiveEvent(tenantId, eventId, at),
    );
  }

  async updateSchedule(
    tenantId: string,
    eventId: string,
    patch: EventSchedulePatch,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.updateSchedule(tenantId, eventId, patch, at), () =>
      this.replica.updateSchedule(tenantId, eventId, patch, at),
    );
  }

  async markTeardown(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markTeardown(tenantId, eventId, at), () =>
      this.replica.markTeardown(tenantId, eventId, at),
    );
  }

  async setProgressionGate(
    tenantId: string,
    eventId: string,
    config: ProgressionGateConfig,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.setProgressionGate(tenantId, eventId, config, at),
      () => this.replica.setProgressionGate(tenantId, eventId, config, at),
    );
  }

  async clearProgressionGate(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<ClearProgressionGateOutcome> {
    return this.mirrorWrite(await this.canonical.clearProgressionGate(tenantId, eventId, at), () =>
      this.replica.clearProgressionGate(tenantId, eventId, at),
    );
  }

  async markDeploying(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markDeploying(tenantId, eventId, at), () =>
      this.replica.markDeploying(tenantId, eventId, at),
    );
  }

  async transitionStatus(
    tenantId: string,
    eventId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.transitionStatus(tenantId, eventId, from, to, at),
      () => this.replica.transitionStatus(tenantId, eventId, from, to, at),
    );
  }

  async markScheduleFired(
    tenantId: string,
    eventId: string,
    kind: ScheduleFiredKind,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.markScheduleFired(tenantId, eventId, kind, at),
      () => this.replica.markScheduleFired(tenantId, eventId, kind, at),
    );
  }

  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<CreateEventWithTeamsOutcome> {
    return this.mirrorWrite(await this.canonical.createEventWithTeams(event, teams), () =>
      this.replica.createEventWithTeams(event, teams),
    );
  }
}
