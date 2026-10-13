import type { OrganizerRole } from "./organizer-access";

export type OrganizerAuthMethod = "host-key" | "local-password" | "saml";

export interface OrganizerIdentityRecord {
  readonly userId: string | null;
  readonly identityId: string | null;
  readonly role: OrganizerRole;
  readonly authMethod: OrganizerAuthMethod;
}
declare const authenticatedOrganizer: unique symbol;
/** Issued only after the session, expiry, identity and auth version have been checked. */
export type OrganizerPrincipal = OrganizerIdentityRecord & {
  readonly [authenticatedOrganizer]: true;
};
