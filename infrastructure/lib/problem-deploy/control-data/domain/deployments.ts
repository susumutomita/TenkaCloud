/** Score remains on the historical deployment aggregate; no second team-score model. */
export interface DeploymentRecord {
  readonly jobId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly status:
    | "PENDING"
    | "IN_PROGRESS"
    | "COMPLETE"
    | "FAILED"
    | "DELETING"
    | "DELETED"
    | "EXPIRED"
    | "AUTO_DELETED";
  readonly expiresAt: number;
  readonly score: number;
  readonly publicOutputs?: Readonly<Record<string, string>>;
  readonly scoring?: { readonly kind: "flag"; readonly points: number };
  readonly flagSubmitted?: boolean;
  readonly failureReason?: string;
  readonly createdAt?: string;
}
