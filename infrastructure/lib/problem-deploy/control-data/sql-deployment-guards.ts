import type { DeploymentConnection } from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import type { SqlStatement } from "./sql-port.js";
import { sqlGuard } from "./sql-transaction.js";
export function sqlEventGuard(event: EventRecord, now: number, scoring = false): SqlStatement {
  return sqlGuard(
    `EXISTS (SELECT 1 FROM cloud_events WHERE event_id = ? AND json_extract(payload, '$.updatedAt') = ? AND json_extract(payload, '$.expiresAt') > ? AND json_extract(payload, '$.status') IN ('DRAFT', 'DEPLOYING', 'READY')${scoring ? " AND (json_type(payload, '$.scoringLocked') IS NULL OR json_type(payload, '$.scoringLocked') = 'false') AND json_extract(payload, '$.startsAt') <= ? AND (json_extract(payload, '$.endsAt') IS NULL OR json_extract(payload, '$.endsAt') > ?))" : ")"}`,
    [
      event.eventId,
      event.updatedAt,
      Math.floor(now / 1000),
      ...(scoring ? [new Date(now).toISOString(), new Date(now).toISOString()] : []),
    ],
  );
}
export function sqlTeamGuard(team: TeamRecord, now: number): SqlStatement {
  return sqlGuard(
    "EXISTS (SELECT 1 FROM cloud_teams WHERE event_id = ? AND team_id = ? AND json_extract(payload, '$.authVersion') = ? AND json_type(payload, '$.accessRevoked') = 'false' AND json_extract(payload, '$.expiresAt') > ?)",
    [team.eventId, team.teamId, team.authVersion, Math.floor(now / 1000)],
  );
}
export function sqlConnectionGuard(connection: DeploymentConnection): SqlStatement {
  return sqlGuard(
    "EXISTS (SELECT 1 FROM cloud_connections WHERE event_id = ? AND team_id = ? AND json_extract(payload, '$.version') = ? AND json_extract(payload, '$.roleArn') = ? AND json_extract(payload, '$.verifiedAt') = ?)",
    [
      connection.eventId,
      connection.teamId,
      connection.version,
      connection.roleArn,
      connection.verifiedAt,
    ],
  );
}
