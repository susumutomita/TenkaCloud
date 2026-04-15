import { CloudFormationClient, DeleteStackCommand } from "@aws-sdk/client-cloudformation";

export interface DeprovisionInput {
  tenantId: string;
  cfnStackPrefix: string;
}

export interface DeprovisionOutput {
  registrationStatus: string;
}

export async function deprovisionTenant(
  input: DeprovisionInput,
  client: CloudFormationClient = new CloudFormationClient({}),
): Promise<DeprovisionOutput> {
  const stackName = `${input.cfnStackPrefix}-${input.tenantId}`;

  try {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("does not exist")) {
      return { registrationStatus: "deleted" };
    }
    throw err;
  }

  return { registrationStatus: "deleted" };
}

/**
 * Generate a bash script that calls this handler via Node.js in CodeBuild.
 */
export function buildDeprovisionScript(): string {
  return `
set -euo pipefail
log() { echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] \$*"; }

log "=== Tenant deprovisioning started ==="
log "tenantId: \${tenantId}"

STACK_NAME="\${CFN_STACK_PREFIX}-\${tenantId}"
log "Deleting stack: \${STACK_NAME}"

node -e "
const { CloudFormationClient, DeleteStackCommand } = require('@aws-sdk/client-cloudformation');
async function main() {
  const client = new CloudFormationClient({});
  const stackName = process.env.CFN_STACK_PREFIX + '-' + process.env.tenantId;
  try {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
    console.log('Delete initiated: ' + stackName);
  } catch (e) {
    if (e.message && e.message.includes('does not exist')) {
      console.log('Stack does not exist, skipping: ' + stackName);
    } else {
      throw e;
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
"

export registrationStatus="deleted"
log "=== Tenant deprovisioning completed ==="
`;
}
