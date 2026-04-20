import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  CloudFormationClient,
  CreateStackCommand,
  waitUntilStackCreateComplete,
} from "@aws-sdk/client-cloudformation";

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
  deployStatus: "completed" | "failed";
  stackName?: string;
  stackId?: string;
  errorReason?: string;
}

const STACK_WAIT_MAX_SECONDS = 60 * 60; // CFn は最大 60 分で足切り

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
      accessKeyId: creds.Credentials.AccessKeyId ?? "",
      secretAccessKey: creds.Credentials.SecretAccessKey ?? "",
      sessionToken: creds.Credentials.SessionToken,
    },
  });

  const appNameLower = input.appName.toLowerCase();
  const stackName = `${appNameLower}-problem-${input.problemId}-team-${input.teamId}`;

  const createResult = await cfnClient.send(
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

  try {
    await waitUntilStackCreateComplete(
      { client: cfnClient, maxWaitTime: STACK_WAIT_MAX_SECONDS },
      { StackName: stackName },
    );
  } catch (error) {
    return {
      deployStatus: "failed",
      stackName,
      stackId: createResult.StackId,
      errorReason: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    deployStatus: "completed",
    stackName,
    stackId: createResult.StackId,
  };
}

/**
 * Generate a bash script that calls this handler via Node.js in CodeBuild.
 * Exits 1 on stack failure so the ScriptJob emits problem.deploy.failed.
 * Exports deployStatus / stackName / stackId / errorReason for outgoing event tenantData.
 */
export function buildDeployProblemScript(): string {
  return `
set -euo pipefail
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "=== Problem deployment started ==="
log "problemId: \${problemId}, teamId: \${teamId}, tenantId: \${tenantId}, deploymentKey: \${deploymentKey:-none}"

if [ -z "\${templateUrl:-}" ]; then
  log "WARN: templateUrl not set, skipping deployment"
  export deployStatus="completed"
  export stackName=""
  export stackId=""
  export errorReason=""
  exit 0
fi

OUTPUT_FILE="$(mktemp)"

node -e "
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const {
  CloudFormationClient,
  CreateStackCommand,
  waitUntilStackCreateComplete,
} = require('@aws-sdk/client-cloudformation');
const fs = require('fs');

const outputFile = process.argv[1];

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

  const create = await cfn.send(new CreateStackCommand({
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

  const stackId = create.StackId || '';
  console.log('Stack creation initiated: ' + stackName + ' (' + stackId + ')');

  try {
    await waitUntilStackCreateComplete(
      { client: cfn, maxWaitTime: ${STACK_WAIT_MAX_SECONDS} },
      { StackName: stackName },
    );
  } catch (e) {
    fs.writeFileSync(outputFile, JSON.stringify({
      stackName, stackId, errorReason: e && e.message ? e.message : String(e),
    }));
    process.exit(2);
  }

  fs.writeFileSync(outputFile, JSON.stringify({ stackName, stackId }));
}

main().catch(e => {
  console.error(e);
  fs.writeFileSync(outputFile, JSON.stringify({
    stackName: '',
    stackId: '',
    errorReason: e && e.message ? e.message : String(e),
  }));
  process.exit(1);
});
" "$OUTPUT_FILE" || NODE_EXIT=$?

NODE_EXIT=\${NODE_EXIT:-0}
PAYLOAD="$(cat "$OUTPUT_FILE" 2>/dev/null || echo '{}')"
rm -f "$OUTPUT_FILE"

export stackName=$(node -e "try { console.log(JSON.parse(process.argv[1]).stackName || '') } catch (_) { console.log('') }" "$PAYLOAD")
export stackId=$(node -e "try { console.log(JSON.parse(process.argv[1]).stackId || '') } catch (_) { console.log('') }" "$PAYLOAD")
export errorReason=$(node -e "try { console.log(JSON.parse(process.argv[1]).errorReason || '') } catch (_) { console.log('') }" "$PAYLOAD")

if [ "$NODE_EXIT" -ne 0 ]; then
  log "ERROR: Stack creation did not reach CREATE_COMPLETE (exit=$NODE_EXIT)"
  export deployStatus="failed"
  exit 1
fi

export deployStatus="completed"
log "=== Problem deployment completed: $stackName ==="
`;
}
