#!/usr/bin/env bun
/**
 * One-time SBT 0.9.5 migration. Dry-run is the default; writes require explicit --apply.
 *
 * Usage:
 * bun run scripts/ops/backfill-tenant-registrations.ts \
 *   --tenant-details-table=<exact-name> \
 *   --tenant-registration-table=<exact-name> \
 *   --expected-account=<12-digit-account-id> \
 *   --expected-region=<aws-region> \
 *   --environment=<environment-tag>
 */
import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
} from "@aws-sdk/client-dynamodb";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import {
  applyTenantRegistrationBackfill,
  planTenantRegistrationBackfill,
  type TenantInventoryRow,
} from "../lib/tenant-registration-backfill";

export interface BackfillArgs {
  readonly tenantDetailsTableName: string;
  readonly tenantRegistrationTableName: string;
  readonly expectedAccountId: string;
  readonly expectedRegion: string;
  readonly environment: string;
  readonly apply: boolean;
}

const VALUE_FLAGS = new Set([
  "--tenant-details-table",
  "--tenant-registration-table",
  "--expected-account",
  "--expected-region",
  "--environment",
]);

function addExactValue(argument: string, values: Map<string, string>): void {
  const separator = argument.indexOf("=");
  const key = separator > 0 ? argument.slice(0, separator) : argument;
  if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown argument: ${argument}`);
  if (separator < 1) throw new Error(`${key} requires =<exact-value>`);
  if (values.has(key)) throw new Error(`${key} was provided more than once`);
  const value = argument.slice(separator + 1).trim();
  if (!value) throw new Error(`${key} requires a non-empty exact value`);
  values.set(key, value);
}

export function parseTenantRegistrationBackfillArgs(argv: readonly string[]): BackfillArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      if (apply) throw new Error("--apply was provided more than once");
      apply = true;
      continue;
    }
    addExactValue(argument, values);
  }
  const tenantDetailsTableName = values.get("--tenant-details-table");
  const tenantRegistrationTableName = values.get("--tenant-registration-table");
  const expectedAccountId = values.get("--expected-account");
  const expectedRegion = values.get("--expected-region");
  const environment = values.get("--environment");
  if (
    !tenantDetailsTableName ||
    !tenantRegistrationTableName ||
    !expectedAccountId ||
    !expectedRegion ||
    !environment
  ) {
    throw new Error(
      "--tenant-details-table, --tenant-registration-table, --expected-account, --expected-region, and --environment are required",
    );
  }
  if (tenantDetailsTableName === tenantRegistrationTableName) {
    throw new Error("Tenant details and tenant-registration table names must be different");
  }
  if (!/^\d{12}$/.test(expectedAccountId)) {
    throw new Error("--expected-account must be a 12 digit AWS account ID");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(expectedRegion)) {
    throw new Error("--expected-region must be an explicit AWS region");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment)) {
    throw new Error("--environment must match the deployed Environment tag");
  }
  return {
    tenantDetailsTableName,
    tenantRegistrationTableName,
    expectedAccountId,
    expectedRegion,
    environment,
    apply,
  };
}

export interface BackfillTableTargetMetadata {
  readonly tableName: string;
  readonly tableArn: string;
  readonly partitionKey: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface BackfillTargetMetadata {
  readonly callerAccountId: string;
  readonly tenantDetails: BackfillTableTargetMetadata;
  readonly tenantRegistrations: BackfillTableTargetMetadata;
}

function validateTableTarget(
  args: BackfillArgs,
  target: BackfillTableTargetMetadata,
  expectedName: string,
  expectedPartitionKey: string,
): void {
  if (target.tableName !== expectedName) {
    throw new Error(`DynamoDB returned table ${target.tableName}, expected ${expectedName}`);
  }
  const arnMatch = /^arn:[^:]+:dynamodb:([^:]+):(\d{12}):table\/([^/]+)$/.exec(target.tableArn);
  if (!arnMatch) throw new Error(`Table ${target.tableName} returned an invalid ARN`);
  if (arnMatch[1] !== args.expectedRegion || arnMatch[2] !== args.expectedAccountId) {
    throw new Error(
      `Table ${target.tableName} is in ${arnMatch[2]}/${arnMatch[1]}, expected ${args.expectedAccountId}/${args.expectedRegion}`,
    );
  }
  if (arnMatch[3] !== expectedName) {
    throw new Error(`Table ARN identifies ${arnMatch[3]}, expected ${expectedName}`);
  }
  if (target.partitionKey !== expectedPartitionKey) {
    throw new Error(
      `Table ${target.tableName} partition key is ${target.partitionKey}, expected ${expectedPartitionKey}`,
    );
  }
  if (target.tags.Project !== "TenkaCloud") {
    throw new Error(`Table ${target.tableName} Project tag is not TenkaCloud`);
  }
  if (target.tags.Environment !== args.environment) {
    throw new Error(
      `Table ${target.tableName} Environment tag is ${target.tags.Environment ?? "missing"}, expected ${args.environment}`,
    );
  }
}

export function validateTenantRegistrationBackfillTargets(
  args: BackfillArgs,
  metadata: BackfillTargetMetadata,
): void {
  if (metadata.callerAccountId !== args.expectedAccountId) {
    throw new Error(
      `AWS caller account is ${metadata.callerAccountId}, expected ${args.expectedAccountId}`,
    );
  }
  validateTableTarget(args, metadata.tenantDetails, args.tenantDetailsTableName, "tenantId");
  validateTableTarget(
    args,
    metadata.tenantRegistrations,
    args.tenantRegistrationTableName,
    "tenantRegistrationId",
  );
}

async function inspectTableTarget(
  client: DynamoDBClient,
  tableName: string,
): Promise<BackfillTableTargetMetadata> {
  const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const table = described.Table;
  const tableArn = table?.TableArn;
  const resolvedTableName = table?.TableName;
  const partitionKey = table?.KeySchema?.find((key) => key.KeyType === "HASH")?.AttributeName;
  if (!tableArn || !resolvedTableName || !partitionKey) {
    throw new Error(`Table ${tableName} did not return ARN, name, and partition key metadata`);
  }
  const tagOutput = await client.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }));
  const tags = Object.fromEntries(
    (tagOutput.Tags ?? []).flatMap((tag) =>
      tag.Key && tag.Value ? [[tag.Key, tag.Value] as const] : [],
    ),
  );
  return { tableName: resolvedTableName, tableArn, partitionKey, tags };
}

interface BackfillClients {
  readonly dynamoClient: DynamoDBClient;
  readonly documentClient: DynamoDBDocumentClient;
  readonly stsClient: STSClient;
}

async function inspectBackfillTargets(
  args: BackfillArgs,
  clients: BackfillClients,
): Promise<BackfillTargetMetadata> {
  const identity = await clients.stsClient.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error("STS GetCallerIdentity returned no account");
  const [tenantDetails, tenantRegistrations] = await Promise.all([
    inspectTableTarget(clients.dynamoClient, args.tenantDetailsTableName),
    inspectTableTarget(clients.dynamoClient, args.tenantRegistrationTableName),
  ]);
  return { callerAccountId: identity.Account, tenantDetails, tenantRegistrations };
}

interface ScanSender {
  send(command: ScanCommand): Promise<ScanCommandOutput>;
}

export async function scanAllTenantRows(
  client: ScanSender,
  tableName: string,
): Promise<TenantInventoryRow[]> {
  const rows: TenantInventoryRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }),
    );
    rows.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

export async function runTenantRegistrationBackfill(
  argv: readonly string[],
  injectedClients?: BackfillClients,
): Promise<number> {
  const args = parseTenantRegistrationBackfillArgs(argv);
  const dynamoClient =
    injectedClients?.dynamoClient ?? new DynamoDBClient({ region: args.expectedRegion });
  const clients: BackfillClients = injectedClients ?? {
    dynamoClient,
    documentClient: DynamoDBDocumentClient.from(dynamoClient),
    stsClient: new STSClient({ region: args.expectedRegion }),
  };
  const targetMetadata = await inspectBackfillTargets(args, clients);
  validateTenantRegistrationBackfillTargets(args, targetMetadata);
  const [tenants, registrations] = await Promise.all([
    scanAllTenantRows(clients.documentClient, args.tenantDetailsTableName),
    scanAllTenantRows(clients.documentClient, args.tenantRegistrationTableName),
  ]);
  const plan = planTenantRegistrationBackfill(tenants, registrations);

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        tenantCount: tenants.length,
        registrationCount: registrations.length,
        createCount: plan.registrations.length,
        skippedTenantIds: plan.skipped,
        blockers: plan.blockers,
        registrations: plan.registrations,
      },
      null,
      2,
    ),
  );

  if (plan.blockers.length > 0) {
    console.error("Backfill is blocked; no writes were attempted.");
    return 2;
  }
  const result = await applyTenantRegistrationBackfill(clients.documentClient, {
    tenantDetailsTableName: args.tenantDetailsTableName,
    tenantRegistrationTableName: args.tenantRegistrationTableName,
    plan,
    apply: args.apply,
  });
  console.log(
    args.apply
      ? `Applied ${result.applied} tenant registration(s).`
      : "Dry run only. Re-run the same command with --apply after reviewing the inventory.",
  );
  return 0;
}

if (import.meta.main) {
  runTenantRegistrationBackfill(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
