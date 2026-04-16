import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

export interface ProvisionInput {
  tenantId: string;
  tier: string;
  tablePrefix: string;
}

export interface ProvisionOutput {
  tenantStatus: string;
}

export async function provisionTenant(
  input: ProvisionInput,
  client: DynamoDBClient = new DynamoDBClient({}),
): Promise<ProvisionOutput> {
  const tableName = `${input.tablePrefix}-Tenants`;
  const timestamp = new Date().toISOString();

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        PK: { S: `TENANT#${input.tenantId}` },
        SK: { S: "METADATA" },
        id: { S: input.tenantId },
        tier: { S: input.tier },
        status: { S: "ACTIVE" },
        CreatedAt: { S: timestamp },
        EntityType: { S: "TENANT" },
      },
    }),
  );

  return { tenantStatus: "created" };
}

/**
 * Generate a bash script that calls this handler via Node.js in CodeBuild.
 * AWS SDK v3 is pre-installed in CodeBuild's Node.js runtime.
 */
export function buildProvisionScript(): string {
  return `
set -euo pipefail
log() { echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] \$*"; }

log "=== Tenant provisioning started ==="
log "tenantId: \${tenantId}, tier: \${tier}"

node -e "
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
async function main() {
  const client = new DynamoDBClient({});
  const tableName = process.env.TABLE_PREFIX + '-Tenants';
  const timestamp = new Date().toISOString();
  await client.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      PK: { S: 'TENANT#' + process.env.tenantId },
      SK: { S: 'METADATA' },
      id: { S: process.env.tenantId },
      tier: { S: process.env.tier },
      status: { S: 'ACTIVE' },
      CreatedAt: { S: timestamp },
      EntityType: { S: 'TENANT' },
    },
  }));
  console.log('DynamoDB put-item succeeded');
}
main().catch(e => { console.error(e); process.exit(1); });
"

export tenantStatus="created"
log "=== Tenant provisioning completed ==="
`;
}
