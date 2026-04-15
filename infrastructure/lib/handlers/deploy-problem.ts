import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { CloudFormationClient, CreateStackCommand } from "@aws-sdk/client-cloudformation";

export interface DeployProblemInput {
  problemId: string;
  teamId: string;
  tenantId: string;
  targetRoleArn: string;
  externalId: string;
  templateUrl?: string;
  appName: string;
}

export interface DeployProblemOutput {
  deployStatus: string;
}

export async function deployProblem(
  input: DeployProblemInput,
  stsClient: STSClient = new STSClient({}),
): Promise<DeployProblemOutput> {
  if (!input.templateUrl) {
    return { deployStatus: "completed" };
  }

  // Cross-account AssumeRole with ExternalId (Confused Deputy protection)
  const creds = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: input.targetRoleArn,
      RoleSessionName: `problem-deploy-${input.problemId}`,
      ExternalId: input.externalId,
    }),
  );

  if (!creds.Credentials) {
    throw new Error("AssumeRole returned no credentials");
  }

  const cfnClient = new CloudFormationClient({
    credentials: {
      accessKeyId: creds.Credentials.AccessKeyId!,
      secretAccessKey: creds.Credentials.SecretAccessKey!,
      sessionToken: creds.Credentials.SessionToken,
    },
  });

  const appNameLower = input.appName.toLowerCase();
  const stackName = `${appNameLower}-problem-${input.problemId}-team-${input.teamId}`;

  await cfnClient.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateURL: input.templateUrl,
      Parameters: [
        { ParameterKey: "ProblemId", ParameterValue: input.problemId },
        { ParameterKey: "TeamId", ParameterValue: input.teamId },
        { ParameterKey: "TenantId", ParameterValue: input.tenantId },
      ],
      Tags: [
        { Key: "AppName", Value: input.appName },
        { Key: "ProblemId", Value: input.problemId },
        { Key: "TeamId", Value: input.teamId },
      ],
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    }),
  );

  return { deployStatus: "completed" };
}

/**
 * Generate a bash script that calls this handler via Node.js in CodeBuild.
 */
export function buildDeployProblemScript(): string {
  return `
set -euo pipefail
log() { echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] \$*"; }

log "=== Problem deployment started ==="
log "problemId: \${problemId}, teamId: \${teamId}, tenantId: \${tenantId}"

if [ -z "\${templateUrl:-}" ]; then
  log "WARN: templateUrl not set, skipping deployment"
  export deployStatus="completed"
  exit 0
fi

node -e "
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { CloudFormationClient, CreateStackCommand } = require('@aws-sdk/client-cloudformation');

async function main() {
  const sts = new STSClient({});
  const creds = await sts.send(new AssumeRoleCommand({
    RoleArn: process.env.targetRoleArn,
    RoleSessionName: 'problem-deploy-' + process.env.problemId,
    ExternalId: process.env.externalId,
  }));

  const cfn = new CloudFormationClient({
    credentials: {
      accessKeyId: creds.Credentials.AccessKeyId,
      secretAccessKey: creds.Credentials.SecretAccessKey,
      sessionToken: creds.Credentials.SessionToken,
    },
  });

  const appName = (process.env.APP_NAME || 'tenkacloud').toLowerCase();
  const stackName = appName + '-problem-' + process.env.problemId + '-team-' + process.env.teamId;

  await cfn.send(new CreateStackCommand({
    StackName: stackName,
    TemplateURL: process.env.templateUrl,
    Parameters: [
      { ParameterKey: 'ProblemId', ParameterValue: process.env.problemId },
      { ParameterKey: 'TeamId', ParameterValue: process.env.teamId },
      { ParameterKey: 'TenantId', ParameterValue: process.env.tenantId },
    ],
    Tags: [
      { Key: 'AppName', Value: process.env.APP_NAME || 'TenkaCloud' },
      { Key: 'ProblemId', Value: process.env.problemId },
      { Key: 'TeamId', Value: process.env.teamId },
    ],
    Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
  }));

  console.log('Stack creation initiated: ' + stackName);
}

main().catch(e => { console.error(e); process.exit(1); });
"

export deployStatus="completed"
log "=== Problem deployment completed ==="
`;
}
