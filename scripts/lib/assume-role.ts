import { AssumeRoleCommand, type Credentials, type STSClient } from "@aws-sdk/client-sts";

function assertCompleteCredentials(credentials: Credentials | undefined): Credentials {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("AssumeRole returned incomplete credentials");
  }
  return credentials;
}

export async function assumeRoleWithExternalId(
  deps: { readonly sts: Pick<STSClient, "send"> },
  args: {
    readonly roleArn: string;
    readonly jobId: string;
    readonly externalId: string;
    readonly sessionNamePrefix: string;
  },
): Promise<Credentials> {
  const assumeOut = await deps.sts.send(
    new AssumeRoleCommand({
      RoleArn: args.roleArn,
      RoleSessionName: `${args.sessionNamePrefix}${args.jobId.slice(0, 24)}`,
      ExternalId: args.externalId,
      DurationSeconds: 900,
    }),
  );
  return assertCompleteCredentials(assumeOut.Credentials);
}
