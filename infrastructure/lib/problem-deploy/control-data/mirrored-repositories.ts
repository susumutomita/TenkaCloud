import type { EventRecord, EventsRepository, TeamRecord, TeamsRepository } from "./types.js";

function sameEventRecord(left: EventRecord, right: EventRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutLoginKey(record: TeamRecord): Omit<TeamRecord, "teamLoginKey"> {
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = record;
  return safeRecord;
}

function sameTeamRecord(left: TeamRecord, right: TeamRecord): boolean {
  return JSON.stringify(withoutLoginKey(left)) === JSON.stringify(withoutLoginKey(right));
}

function restoreLoginKey(record: TeamRecord, canonical: TeamRecord): TeamRecord {
  return canonical.teamLoginKey ? { ...record, teamLoginKey: canonical.teamLoginKey } : record;
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
}

/** DynamoDB-primary/Turso-replica equivalent for the Teams aggregate. */
export class MirroredTeamsRepository implements TeamsRepository {
  constructor(
    private readonly canonical: TeamsRepository,
    private readonly replica: TeamsRepository,
  ) {}

  async getTeam(
    tenantId: string,
    eventId: string,
    teamId: string,
  ): Promise<TeamRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getTeam(tenantId, eventId, teamId),
      this.replica.getTeam(tenantId, eventId, teamId),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteTeam(eventId, teamId);
      return undefined;
    }
    if (!replica || !sameTeamRecord(canonical, replica)) {
      await this.replica.putTeam(canonical);
    }
    const reconciled = await this.replica.getTeam(tenantId, eventId, teamId);
    return reconciled ? restoreLoginKey(reconciled, canonical) : canonical;
  }

  async getTeamByLoginKey(loginKey: string): Promise<TeamRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getTeamByLoginKey(loginKey),
      this.replica.getTeamByLoginKey(loginKey),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteTeam(replica.eventId, replica.teamId);
      return undefined;
    }
    if (!replica || !sameTeamRecord(canonical, replica)) {
      await this.replica.putTeam(canonical);
    }
    return (await this.replica.getTeamByLoginKey(loginKey)) ?? canonical;
  }

  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    const [canonical, replica] = await Promise.all([
      this.canonical.listTeamsByEvent(eventId),
      this.replica.listTeamsByEvent(eventId),
    ]);
    const canonicalById = new Map(canonical.map((record) => [record.teamId, record]));
    const replicaById = new Map(replica.map((record) => [record.teamId, record]));
    await Promise.all([
      ...canonical
        .filter((record) => {
          const mirrored = replicaById.get(record.teamId);
          return !mirrored || !sameTeamRecord(record, mirrored);
        })
        .map((record) => this.replica.putTeam(record)),
      ...replica
        .filter((record) => !canonicalById.has(record.teamId))
        .map((record) => this.replica.deleteTeam(eventId, record.teamId)),
    ]);
    const reconciled = await this.replica.listTeamsByEvent(eventId);
    return reconciled.map((record) => {
      const canonicalRecord = canonicalById.get(record.teamId);
      return canonicalRecord ? restoreLoginKey(record, canonicalRecord) : record;
    });
  }

  async putTeam(record: TeamRecord): Promise<void> {
    await this.canonical.putTeam(record);
    await this.replica.putTeam(record);
  }

  async deleteTeam(eventId: string, teamId: string): Promise<void> {
    await this.replica.deleteTeam(eventId, teamId);
    await this.canonical.deleteTeam(eventId, teamId);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}
