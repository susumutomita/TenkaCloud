/** Historical self-registration payload, retained for stored-event compatibility. */
export interface EventRegistration {
  readonly version: number;
  readonly enabled: boolean;
  readonly invitationHash: string;
  readonly closesAt: string;
  readonly teamIds: readonly string[];
  readonly claims: readonly {
    readonly receiptHash: string;
    /** Absent on older stored receipts. */
    readonly teamLoginKeyHash?: string;
    readonly teamId: string;
    readonly claimedAt: string;
  }[];
}
