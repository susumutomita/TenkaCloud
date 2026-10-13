import { HostError } from "./model";
import type { OrganizerPrincipal } from "./organizer-principal";

/** Server-owned role on an issued host session; browser JWT claims are never authority. */
export type OrganizerRole = "Admin" | "Operator" | "Viewer";
export type OrganizerPermission = "read" | "run-events" | "manage-connections" | "reveal-team-keys";

const permissions: Record<OrganizerRole, readonly OrganizerPermission[]> = {
  Admin: ["read", "run-events", "manage-connections", "reveal-team-keys"],
  Operator: ["read", "run-events", "reveal-team-keys"],
  Viewer: ["read"],
};

export function requireOrganizerPermission(
  principal: OrganizerPrincipal,
  permission: OrganizerPermission,
): void {
  if (!permissions[principal.role]?.includes(permission))
    throw new HostError(403, "Organizer role does not permit this operation.");
}
