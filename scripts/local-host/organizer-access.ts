import { HostError } from "./model";

/** Server-owned role on an issued host session; browser JWT claims are never authority. */
export type OrganizerRole = "Admin" | "Operator" | "Viewer";
export type OrganizerPermission = "read" | "run-events" | "manage-connections" | "reveal-team-keys";

const permissions: Record<OrganizerRole, readonly OrganizerPermission[]> = {
  Admin: ["read", "run-events", "manage-connections", "reveal-team-keys"],
  Operator: ["read", "run-events", "reveal-team-keys"],
  Viewer: ["read"],
};

export function requireOrganizerPermission(
  role: OrganizerRole,
  permission: OrganizerPermission,
): void {
  if (!permissions[role].includes(permission))
    throw new HostError(403, "Organizer role does not permit this operation.");
}
