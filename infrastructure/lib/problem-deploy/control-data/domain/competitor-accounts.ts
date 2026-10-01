/** Historical competitor-account wire fields, scoped to one installation rather than a tenant. */
export interface CompetitorAccountRecord {
  readonly awsAccountId: string;
  /** Registration/bootstrap region; the account's global IAM role also serves other team regions. */
  readonly region: string;
  readonly competitorRoleName: string;
  readonly alias?: string;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  /** A deleted/re-created account must never inherit an earlier verification or connection. */
  readonly registrationId: string;
  /** CAS fence shared by verification, deletion, and new event/team references. */
  readonly revision: number;
}
export interface CompetitorAccountsRepository {
  listAccounts(): Promise<readonly CompetitorAccountRecord[]>;
  getAccount(awsAccountId: string): Promise<CompetitorAccountRecord | undefined>;
  createAccount(record: CompetitorAccountRecord): Promise<"created" | "conflict">;
  setVerified(
    record: CompetitorAccountRecord,
    verified: boolean,
    at: string,
  ): Promise<CompetitorAccountRecord | undefined>;
  deleteAccount(record: CompetitorAccountRecord): Promise<"deleted" | "in_use" | "conflict">;
}

export interface InstallationCompetitorConfig {
  readonly roleName: string;
  readonly externalIdParameterArn: string;
}
