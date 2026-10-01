/** Historical EVENT#/TEAM# record contract; login material is organizer-only. */
export interface TeamRecord {
  readonly eventId: string;
  readonly teamId: string;
  readonly internalSlug: string;
  readonly displayName?: string;
  readonly awsAccountId?: string;
  readonly region?: string;
  readonly teamLoginKey: string;
  readonly authVersion: number;
  readonly accessRevoked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
}
