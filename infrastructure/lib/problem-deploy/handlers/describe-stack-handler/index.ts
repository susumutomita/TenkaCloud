import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Credentials } from "@aws-sdk/client-sts";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { errorDeployTrace, logDeployTrace, warnDeployTrace } from "../shared/trace-log.js";

export interface DescribeStackStateMachineInput {
  readonly detail?: {
    readonly jobId?: string;
    readonly correlationId?: string;
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
    warnDeployTrace("deploy.describe-stack.assume-role.grace-fallback", {
      jobId: params.jobId,
      correlationId: params.jobId,
      region: params.region,
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

/**
 * Issue (regression 調査): Step Functions 経由で渡される `input.detail.jobId`
 * が undefined で fail するケースが 1 回観測された (= ジョブ ID は DDB row に
 * 入っているのに、 Lambda が受け取った payload では `detail` が無いか jobId
 * が抜けている)。 原因確定のため、 必須 field validation 前に input の構造を
 * 1 行 JSON で trace log する。 `tenantId` / `namePrefix` 等の non-secret な
 * shape 情報のみを残し、 PII / secret は含めない (= credential / external id
 * は input に乗らない、 SSM parameter name のみ)。
 *
 * 用途: 次回 regression 再現時に CloudWatch Logs Insights で
 *   filter event = "deploy.describe-stack.input-received"
 * を引けば実 payload 構造が見える。 原因が確定したらこの trace は残してもよい
 * (= structural log は long-term observability に有用)。
 */
function logInputShape(input: DescribeStackStateMachineInput): void {
  const detail = input.detail;
  errorDeployTrace("deploy.describe-stack.input-received", {
    hasDetail: detail !== undefined && detail !== null,
    hasJobId: typeof detail?.jobId === "string" && detail.jobId.length > 0,
    hasNamePrefix: typeof detail?.namePrefix === "string" && detail.namePrefix.length > 0,
    hasRegion: typeof detail?.region === "string" && detail.region.length > 0,
    hasTenantId: typeof detail?.tenantId === "string" && detail.tenantId.length > 0,
    hasCompetitorRoleArn:
      typeof detail?.competitorRoleArn === "string" && detail.competitorRoleArn.length > 0,
    hasExternalIdParameterName:
      typeof detail?.externalIdParameterName === "string" &&
      detail.externalIdParameterName.length > 0,
    detailKeys: detail && typeof detail === "object" ? Object.keys(detail).join(",") : "",
    topLevelKeys: Object.keys(input as Record<string, unknown>).join(","),
  });
}

export async function describeStackForDeployment(
  input: DescribeStackStateMachineInput,
  deps: DescribeStackDeps,
) {
  const detail = input.detail ?? {};
  if (typeof detail.jobId !== "string" || detail.jobId.length === 0) {
    logInputShape(input);
  }
  const jobId = requireString(detail.jobId, "detail.jobId");
  const correlationId = detail.correlationId || jobId;
  const stackName = requireString(detail.namePrefix, "detail.namePrefix");
  const region = requireString(detail.region, "detail.region");
  logDeployTrace("deploy.describe-stack.start", {
    jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName,
    region,
    hasCompetitorRole: Boolean(detail.competitorRoleArn),
  });
  const credentials = await assumeCompetitorRole(deps, {
    region,
    jobId,
    competitorRoleArn: detail.competitorRoleArn,
    externalIdParameterName: detail.externalIdParameterName,
  });
  const cfn = deps.cfnClient({ region, credentials });
  const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  logDeployTrace("deploy.describe-stack.succeeded", {
    jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName,
    region,
    stackStatus: out.Stacks?.[0]?.StackStatus,
    stackId: out.Stacks?.[0]?.StackId,
  });
  return out;
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
