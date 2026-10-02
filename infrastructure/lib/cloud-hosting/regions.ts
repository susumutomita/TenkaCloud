/** Existing exercise IAM templates target arn:aws; other partitions are deliberately unsupported. */
export const COMMERCIAL_REGION =
  /^(?:us|eu|ap|ca|sa|af|me|il|mx)-(?:central|north|northeast|northwest|south|southeast|southwest|east|west)-\d+$/u;
export function assertCommercialRegion(region: string): void {
  if (!COMMERCIAL_REGION.test(region))
    throw new Error(
      "Cloud hosting currently supports standard commercial AWS regions only (not GovCloud, China, or isolated partitions).",
    );
}

/** Keep the CLI's verified target authoritative when CDK regenerates its default variables. */
export function cloudDeploymentTarget(env: NodeJS.ProcessEnv): { account: string; region: string } {
  const account = env.ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const region =
    env.REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? env.CDK_DEFAULT_REGION ?? "";
  assertCommercialRegion(region);
  if (!/^\d{12}$/u.test(account)) throw new Error("An explicit 12-digit AWS account is required.");
  return { account, region };
}
