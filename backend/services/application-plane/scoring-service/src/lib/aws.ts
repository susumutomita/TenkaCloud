import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';

function getRegion(): string {
  return process.env.AWS_REGION ?? 'ap-northeast-1';
}

function getEndpoint(): string | undefined {
  return process.env.AWS_ENDPOINT;
}

export function createSTSClient(): STSClient {
  const endpoint = getEndpoint();
  return new STSClient({
    region: getRegion(),
    ...(endpoint && { endpoint }),
  });
}

export interface AssumeRoleResult {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function assumeRole(
  roleArn: string,
  sessionName: string
): Promise<AssumeRoleResult> {
  const sts = createSTSClient();

  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: 900,
    })
  );

  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error('AssumeRole で認証情報を取得できませんでした');
  }

  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

export function createS3Client(credentials?: AssumeRoleResult): S3Client {
  const endpoint = getEndpoint();
  return new S3Client({
    region: getRegion(),
    ...(endpoint && { endpoint, forcePathStyle: true }),
    ...(credentials && {
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    }),
  });
}
