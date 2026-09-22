/** Event-scoped, bounded allocation of organizer-prepared team environments. */
export interface EventRegistration {
  readonly version: number;
  readonly enabled: boolean;
  readonly invitationHash: string;
  readonly closesAt: string;
  readonly teamIds: readonly string[];
  readonly claims: readonly {
    readonly receiptHash: string;
    readonly teamId: string;
    readonly claimedAt: string;
  }[];
}

export interface RegistrationUpdate {
  readonly tenantId: string;
  readonly eventId: string;
  readonly expectedVersion: number;
  readonly registration: EventRegistration;
  readonly now: string;
}
