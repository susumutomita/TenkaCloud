import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Credentials } from "@aws-sdk/client-sts";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export interface DescribeStackStateMachineInput {
  readonly detail?: {
    readonly jobId?: string;
    readonly tenantId?: string;
    readonly namePrefix?: string;
    readonly region?: string;
    readonly competitorRoleArn?: string;
    readonly externalIdParameterName?: string;
  };
}

export interface DescribeStackDeps {
  readonly ssm: Pick<SSMClient, "send">;
  readonly sts: Pick<STSClient, "send">;
  readonly cfnClient: (params: {
    readonly region: string;
    readonly credentials?: Credentials;
  }) => Pick<CloudFormationClient, "send">;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required field: ${field}`);
  }
  return value;
}

function assertCompleteCredentials(credentials: Credentials | undefined): Credentials {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("AssumeRole returned incomplete credentials");
  }
  return credentials;
}

async function assumeCompetitorRole(
  deps: DescribeStackDeps,
  params: {
    readonly region: string;
    readonly jobId: string;
    readonly competitorRoleArn?: string;
    readonly externalIdParameterName?: string;
  },
): Promise<Credentials | undefined> {
  const hasRole =
    typeof params.competitorRoleArn === "string" && params.competitorRoleArn.length > 0;
  const hasExternalId =
    typeof params.externalIdParameterName === "string" && params.externalIdParameterName.length > 0;
  if (!hasRole && !hasExternalId) return undefined;
  if (!hasRole || !hasExternalId) {
    throw new Error("competitorRoleArn and externalIdParameterName must be provided together");
  }

  const externalIdOut = await deps.ssm.send(
    new GetParameterCommand({
      Name: params.externalIdParameterName,
      WithDecryption: true,
    }),
  );
  const externalId = externalIdOut.Parameter?.Value;
  if (!externalId) {
    throw new Error(`ExternalId not found in SSM SecureString: ${params.externalIdParameterName}`);
  }

  try {
    return await assumeRoleWithExternalId(deps, params.competitorRoleArn, params.jobId, externalId);
  } catch (currentErr) {
    const previousVersion = Number(externalIdOut.Parameter?.Version ?? 0) - 1;
    if (previousVersion <= 0) throw currentErr;
    const previousExternalIdOut = await deps.ssm.send(
      new GetParameterCommand({
        Name: `${params.externalIdParameterName}:${previousVersion}`,
        WithDecryption: true,
      }),
    );
    const previousExternalId = previousExternalIdOut.Parameter?.Value;
    if (!previousExternalId) throw currentErr;
    const credentials = await assumeRoleWithExternalId(
      deps,
      params.competitorRoleArn,
      params.jobId,
      previousExternalId,
    );
    console.warn("[describe-stack] grace_fallback_used", {
      jobId: params.jobId,
      externalIdVersion: previousVersion,
    });
    return credentials;
  }
}

async function assumeRoleWithExternalId(
  deps: DescribeStackDeps,
  roleArn: string,
  jobId: string,
  externalId: string,
): Promise<Credentials> {
  const assumeOut = await deps.sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `tenkacloud-describe-stack-${jobId.slice(0, 24)}`,
      ExternalId: externalId,
      DurationSeconds: 900,
    }),
  );
  return assertCompleteCredentials(assumeOut.Credentials);
}

export async function describeStackForDeployment(
  input: DescribeStackStateMachineInput,
  deps: DescribeStackDeps,
) {
  const detail = input.detail ?? {};
  const jobId = requireString(detail.jobId, "detail.jobId");
  const stackName = requireString(detail.namePrefix, "detail.namePrefix");
  const region = requireString(detail.region, "detail.region");
  const credentials = await assumeCompetitorRole(deps, {
    region,
    jobId,
    competitorRoleArn: detail.competitorRoleArn,
    externalIdParameterName: detail.externalIdParameterName,
  });
  const cfn = deps.cfnClient({ region, credentials });
  return cfn.send(new DescribeStacksCommand({ StackName: stackName }));
}

const ssm = new SSMClient({});
const sts = new STSClient({});

export async function handler(input: DescribeStackStateMachineInput) {
  return describeStackForDeployment(input, {
    ssm,
    sts,
    cfnClient: ({ region, credentials }) =>
      new CloudFormationClient({
        region,
        ...(credentials
          ? {
              credentials: {
                accessKeyId: credentials.AccessKeyId ?? "",
                secretAccessKey: credentials.SecretAccessKey ?? "",
                sessionToken: credentials.SessionToken,
              },
            }
          : {}),
      }),
  });
}
