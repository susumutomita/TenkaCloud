/** Cloud resource exercises are supported only in a separate competitor account. */
export class UnsupportedHostingAccountError extends Error {
  readonly code = "unsupported_hosting_account";
  constructor(readonly awsAccountId: string) {
    super(
      "AWS resource exercises cannot target the platform hosting account. Register and verify a separate competitor AWS account before deploying.",
    );
    this.name = "UnsupportedHostingAccountError";
  }
}

export function assertSeparateCompetitorAccount(awsAccountId: string): void {
  const hostingAccount = process.env.CONTROL_PLANE_ACCOUNT;
  if (hostingAccount && awsAccountId === hostingAccount)
    throw new UnsupportedHostingAccountError(awsAccountId);
}
