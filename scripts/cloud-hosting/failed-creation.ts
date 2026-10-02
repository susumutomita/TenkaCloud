import { z } from "zod";
import { cloudStackTags } from "../../infrastructure/lib/cloud-hosting/stack-names";
import type { ProcessResult } from "./process";

export interface PlatformStack {
  readonly name: string;
  readonly arn: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly status: string;
}
interface RecoveryContext {
  readonly account: string;
  readonly region: string;
  readonly environment: string;
  readonly appName: string;
  readonly backendName: string;
  readonly run: (args: readonly string[]) => Promise<ProcessResult>;
}
const initialFailureStatuses = ["CREATE_FAILED", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE"];
export function canRecoverCreation(status: string): boolean {
  return [...initialFailureStatuses, "DELETE_FAILED", "DELETE_IN_PROGRESS"].includes(status);
}
const resourceSchema = z.object({
  Type: z.string(),
  DeletionPolicy: z.string().optional(),
  UpdateReplacePolicy: z.string().optional(),
  Properties: z.record(z.unknown()).optional(),
});
const templateSchema = z.object({
  Resources: z.record(resourceSchema),
  Outputs: z.record(z.object({ Value: z.unknown() })),
});
const inventorySchema = z.object({
  StackResourceSummaries: z.array(
    z.object({
      LogicalResourceId: z.string(),
      PhysicalResourceId: z.string().optional(),
      ResourceType: z.string(),
      ResourceStatus: z.string(),
    }),
  ),
  NextToken: z.never().optional(),
});
type Inventory = z.infer<typeof inventorySchema>["StackResourceSummaries"];
interface Evidence {
  readonly template: z.infer<typeof templateSchema>;
  readonly resources: Inventory;
}
async function read(context: RecoveryContext, args: readonly string[]): Promise<string> {
  const result = await context.run([...args, "--region", context.region, "--output", "json"]);
  if (result.code !== 0)
    throw new Error(
      `Failed-creation recovery could not verify ${args[1]}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}
async function evidence(context: RecoveryContext, stack: PlatformStack): Promise<Evidence> {
  const raw = z
    .object({ TemplateBody: z.unknown() })
    .parse(
      JSON.parse(
        await read(context, ["cloudformation", "get-template", "--stack-name", stack.arn]),
      ) as unknown,
    );
  const template = templateSchema.parse(
    typeof raw.TemplateBody === "string"
      ? (JSON.parse(raw.TemplateBody) as unknown)
      : raw.TemplateBody,
  );
  // AWS CLI merges every page by default. Reject a truncated response instead of
  // accepting an incomplete inventory (the CLI pagination token is opaque).
  const { StackResourceSummaries: resources } = inventorySchema.parse(
    JSON.parse(
      await read(context, ["cloudformation", "list-stack-resources", "--stack-name", stack.arn]),
    ) as unknown,
  );
  const seen = new Set<string>();
  for (const resource of resources) {
    if (
      seen.has(resource.LogicalResourceId) ||
      template.Resources[resource.LogicalResourceId]?.Type !== resource.ResourceType ||
      resource.ResourceStatus.endsWith("_IN_PROGRESS")
    )
      throw new Error(
        "Ambiguous or changing failed-stack resource inventory; wait and retry destroy.",
      );
    seen.add(resource.LogicalResourceId);
  }
  return { template, resources };
}
/** DELETE_FAILED can also follow a healthy installation. Require its exact stack history. */
async function assertInitialCreation(
  context: RecoveryContext,
  stack: PlatformStack,
): Promise<void> {
  if (!canRecoverCreation(stack.status))
    throw new Error(
      "Missing outputs are not proof of a failed initial creation; no resources were removed.",
    );
  const events = z
    .object({
      NextToken: z.never().optional(),
      StackEvents: z.array(
        z.object({
          PhysicalResourceId: z.string().optional(),
          ResourceType: z.string(),
          ResourceStatus: z.string(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await read(context, ["cloudformation", "describe-stack-events", "--stack-name", stack.arn]),
      ) as unknown,
    )
    .StackEvents.filter(
      (event) =>
        event.PhysicalResourceId === stack.arn &&
        event.ResourceType === "AWS::CloudFormation::Stack",
    );
  if (
    !events.some((event) => initialFailureStatuses.includes(event.ResourceStatus)) ||
    events.some(
      (event) =>
        event.ResourceStatus === "CREATE_COMPLETE" ||
        /^(UPDATE|IMPORT)_/u.test(event.ResourceStatus),
    )
  )
    throw new Error(
      "Stack history does not prove failed initial creation; preserve the installation and review its drain state.",
    );
}
function referencedResource(
  e: Evidence,
  output: string,
  type: string,
): { logical: string; physical?: string } {
  const logical = z
    .object({ Ref: z.string() })
    .strict()
    .parse(e.template.Outputs[output]?.Value).Ref;
  const resource = e.template.Resources[logical];
  if (
    !resource ||
    resource.Type !== type ||
    resource.DeletionPolicy !== "Retain" ||
    resource.UpdateReplacePolicy !== "Retain"
  )
    throw new Error(`Cannot verify retained ownership for ${output}; no resources were removed.`);
  const physical = e.resources.find(
    (item) => item.LogicalResourceId === logical,
  )?.PhysicalResourceId;
  return { logical, physical };
}
async function tableIdentity(
  context: RecoveryContext,
  stack: PlatformStack,
  e: Evidence,
  kind: string,
): Promise<string | undefined> {
  const { logical, physical } = referencedResource(e, `${kind}TableName`, "AWS::DynamoDB::Table");
  if (!physical) {
    const resource = e.resources.find((item) => item.LogicalResourceId === logical);
    if (resource && !["CREATE_FAILED", "DELETE_COMPLETE"].includes(resource.ResourceStatus))
      throw new Error(`Missing physical identity for ${kind}; no resources were removed.`);
    return undefined;
  }
  if (!physical.startsWith(`${stack.name}-${kind}`) || !/^[A-Za-z0-9_.-]{3,255}$/u.test(physical))
    throw new Error(`Unowned ${kind} resource in failed stack; no resources were removed.`);
  const arn = `arn:aws:dynamodb:${context.region}:${context.account}:table/${physical}`;
  const table = await describeCreatedTable(
    context,
    physical,
    e.resources.find((item) => item.LogicalResourceId === logical)?.ResourceStatus,
  );
  if (!table) return undefined;
  if (table.TableArn !== arn || table.TableName !== physical || table.TableStatus !== "ACTIVE")
    throw new Error(`Table ${kind} identity or readiness could not be verified.`);
  const tags = z
    .object({ Tags: z.array(z.object({ Key: z.string(), Value: z.string() })) })
    .parse(
      JSON.parse(
        await read(context, ["dynamodb", "list-tags-of-resource", "--resource-arn", arn]),
      ) as unknown,
    ).Tags;
  const required = {
    ...cloudStackTags(context.environment),
  };
  // System-tag propagation varies by AWS resource type. The ARN-bound inventory
  // supplies the physical association; reject conflicting system tags when present.
  const systemTags = {
    "aws:cloudformation:stack-id": stack.arn,
    "aws:cloudformation:logical-id": logical,
  };
  if (
    Object.entries(systemTags).some(([key, value]) =>
      tags.some((tag) => tag.Key === key && tag.Value !== value),
    )
  )
    throw new Error(`Table ${kind} CloudFormation ownership conflicts with its inventory.`);
  if (
    !Object.entries(required).every(
      ([key, value]) => tags.filter((tag) => tag.Key === key && tag.Value === value).length === 1,
    )
  )
    throw new Error(`Table ${kind} ownership is unverified; no resources were removed.`);
  if (
    stack.outputs[`${kind}TableName`] !== undefined &&
    stack.outputs[`${kind}TableName`] !== physical
  )
    throw new Error(`Table ${kind} output disagrees with its physical resource.`);
  return physical;
}
async function describeCreatedTable(
  context: RecoveryContext,
  physical: string,
  status: string | undefined,
): Promise<{ TableArn: string; TableStatus: string; TableName: string } | undefined> {
  const tableResult = await context.run([
    "dynamodb",
    "describe-table",
    "--table-name",
    physical,
    "--region",
    context.region,
    "--output",
    "json",
  ]);
  if (tableResult.code !== 0) {
    if (
      tableResult.stderr.includes("(ResourceNotFoundException)") &&
      ["CREATE_FAILED", "DELETE_COMPLETE"].includes(status ?? "")
    )
      return undefined;
    throw new Error(
      `Failed-creation recovery could not verify describe-table: ${tableResult.stderr.trim()}`,
    );
  }
  return z
    .object({
      Table: z.object({ TableArn: z.string(), TableStatus: z.string(), TableName: z.string() }),
    })
    .parse(JSON.parse(tableResult.stdout) as unknown).Table;
}
export interface FailedCreationRecovery {
  readonly stacks: readonly PlatformStack[];
  readonly tables: readonly string[];
  readonly backendOnly: boolean;
  readonly emptyOnly: boolean;
  assertEmpty(): Promise<void>;
}
/** Never discover tables by prefix or scan AWS globally: inspect only this owned stack's resources. */
export async function recoverFailedCreation(
  context: RecoveryContext,
  stacks: readonly PlatformStack[],
): Promise<FailedCreationRecovery> {
  const app = stacks.find((stack) => stack.name === context.appName);
  const backend = stacks.find((stack) => stack.name === context.backendName);
  if (!backend)
    throw new Error("Backend is missing; failed-creation data ownership cannot be verified.");
  await assertInitialCreation(context, app ?? backend);
  if (app && backend.status !== "CREATE_COMPLETE")
    throw new Error(
      "Failed application recovery requires its complete backend; preserve partial data for review.",
    );
  const backendEvidence = await evidence(context, backend);
  if (
    Object.values(backendEvidence.template.Resources).filter(
      (resource) => resource.Type === "AWS::DynamoDB::Table",
    ).length !== 3
  )
    throw new Error("Unexpected backend data resources; no resources were removed.");
  const outputs = { ...backend.outputs };
  const tables: string[] = [];
  for (const kind of ["Events", "Teams", "Deployments"]) {
    const table = await tableIdentity(context, backend, backendEvidence, kind);
    if (table) {
      outputs[`${kind}TableName`] = table;
      tables.push(table);
    }
  }
  if (new Set(tables).size !== tables.length || (app && tables.length !== 3))
    throw new Error(
      "Complete distinct installation tables could not be verified; no resources were removed.",
    );
  const { recoveredApp, emptyOnly } = app
    ? await recoverApplication(context, app)
    : { recoveredApp: undefined, emptyOnly: true };
  return {
    stacks: [...(recoveredApp ? [recoveredApp] : []), { ...backend, outputs }],
    tables,
    backendOnly: !app,
    emptyOnly,
    assertEmpty: async () => {
      for (const table of tables)
        await assertEmptyTable(context, table, Boolean(app) && table === outputs.EventsTableName);
    },
  };
}
async function recoverApplication(
  context: RecoveryContext,
  app: PlatformStack,
): Promise<{ recoveredApp: PlatformStack; emptyOnly: boolean }> {
  const appEvidence = await evidence(context, app);
  const version = appEvidence.template.Outputs.CloudInstallationControlVersion?.Value;
  const runner = appEvidence.template.Outputs.CloudRunnerEnabled?.Value;
  if (
    typeof version !== "string" ||
    !["1", "2"].includes(version) ||
    typeof runner !== "string" ||
    !["true", "false"].includes(runner)
  )
    throw new Error(
      "Failed application template does not prove the durable intake-fence contract.",
    );
  const appOutputs: Record<string, string> = {
    ...app.outputs,
    CloudInstallationControlVersion: version,
    CloudRunnerEnabled: runner,
  };
  let emptyOnly = version === "2";
  if (version === "2") {
    const bucket = referencedResource(
      appEvidence,
      "CloudExecutionArtifactBucket",
      "AWS::S3::Bucket",
    ).physical;
    const catalog = appEvidence.template.Outputs.CloudExecutionCatalogKey?.Value;
    if (bucket && typeof catalog === "string" && /^catalogs\/[a-f0-9]{64}\.json$/u.test(catalog)) {
      appOutputs.CloudExecutionArtifactBucket = bucket;
      appOutputs.CloudExecutionCatalogKey = catalog;
      emptyOnly = false;
    }
  }
  if (Object.entries(app.outputs).some(([key, value]) => appOutputs[key] !== value))
    throw new Error("Failed application outputs disagree with its verified template or resources.");
  return { recoveredApp: { ...app, outputs: appOutputs }, emptyOnly };
}
function isControlRow(item: Record<string, unknown>): boolean {
  return (
    JSON.stringify(item.PK) === '{"S":"INSTALLATION"}' &&
    JSON.stringify(item.SK) === '{"S":"CONTROL"}'
  );
}
function nonemptyCursor(
  cursor: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return cursor && Object.keys(cursor).length > 0 ? cursor : undefined;
}
async function assertEmptyTable(
  context: RecoveryContext,
  table: string,
  fenced: boolean,
): Promise<void> {
  let cursor: Record<string, unknown> | undefined;
  const cursors = new Set<string>();
  do {
    const page = z
      .object({
        Items: z.array(z.record(z.unknown())),
        LastEvaluatedKey: z.record(z.unknown()).optional(),
      })
      .parse(
        JSON.parse(
          await read(context, [
            "dynamodb",
            "scan",
            "--table-name",
            table,
            "--consistent-read",
            "--limit",
            "100",
            "--no-paginate",
            ...(cursor ? ["--exclusive-start-key", JSON.stringify(cursor)] : []),
          ]),
        ) as unknown,
      );
    for (const item of page.Items) {
      // This one row is written by the existing durable fence before the scan.
      if (!(fenced && isControlRow(item)))
        throw new Error(
          "Failed creation contains stored data or event work. Hosting and retained data were preserved; restore the matching runner to complete coordinated drain.",
        );
    }
    cursor = nonemptyCursor(page.LastEvaluatedKey);
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (cursors.has(key))
        throw new Error("Repeated table scan cursor; empty state is unverified.");
      cursors.add(key);
    }
  } while (cursor);
}
