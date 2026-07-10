import type { TeamRecord, TeamsRepository } from "./types.js";

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
