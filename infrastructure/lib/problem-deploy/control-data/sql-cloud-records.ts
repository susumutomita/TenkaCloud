import { ID } from "./cloud-records.js";
import type { SqlRow } from "./sql-port.js";

export function sqlPayload(row: SqlRow): unknown {
  if (typeof row.payload !== "string") throw new Error("Invalid SQL record payload.");
  return JSON.parse(row.payload) as unknown;
}
export function assertEventId(eventId: string): void {
  if (!ID.test(eventId)) throw new Error("Invalid event ID.");
}
export function assertTeamId(eventId: string, teamId: string): void {
  assertEventId(eventId);
  if (!ID.test(teamId)) throw new Error("Invalid team ID.");
}
