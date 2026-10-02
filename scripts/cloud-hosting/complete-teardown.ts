import { z } from "zod";
import { cloudStackTags } from "../../infrastructure/lib/cloud-hosting/stack-names";
import type { PlatformStack } from "./failed-creation";
import type { ProcessResult } from "./process";

interface TeardownContext {
  readonly account: string;
  readonly region: string;
  readonly environment: string;
  readonly stacks: readonly PlatformStack[];
  readonly run: (args: readonly string[]) => Promise<ProcessResult>;
}
interface OwnedTable {
  readonly name: string;
  readonly arn: string;
  readonly stackArn: string;
  readonly retention: string;
  readonly protected: boolean;
}
interface RetainedResource {
  readonly logicalId: string;
  readonly physicalId: string;
  readonly resourceType: string;
  readonly stackArn: string;
  readonly deletionPolicy: "Retain" | "RetainExceptOnCreate";
}
export interface TeardownPlan {
  readonly region: string;
  readonly tables: readonly OwnedTable[];
  readonly logGroups: readonly string[];
  readonly retainedResources: readonly RetainedResource[];
  readonly storageOutputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
const templateSchema = z.object({
  Resources: z.record(z.object({ Type: z.string(), DeletionPolicy: z.string().optional() })),
  Outputs: z.record(z.object({ Value: z.unknown() })).optional(),
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
function missing(result: ProcessResult): boolean {
  return /\(ResourceNotFoundException\)|\(ResourceNotFound\)/u.test(result.stderr);
}
async function read(context: TeardownContext, args: readonly string[]): Promise<unknown> {
  const result = await context.run([...args, "--region", context.region, "--output", "json"]);
  if (result.code !== 0)
    throw new Error(`Ownership discovery ${args[1]} failed: ${result.stderr.trim()}`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(
      `Ownership discovery ${args[1]} returned invalid JSON; no resources were removed.`,
    );
  }
}
/** Baseline cleanup scope: exact CFN tables/logs and logs derived from its Lambda/CodeBuild IDs. */
export function parseStackOwnedCleanupResources(stdout: string):
  | {
      readonly tableNames: readonly string[];
      readonly logGroupNames: readonly string[];
    }
  | undefined {
  try {
    const parsed = inventorySchema.safeParse(JSON.parse(stdout) as unknown);
    if (!parsed.success) return undefined;
    return collectCleanupResources(parsed.data.StackResourceSummaries);
  } catch {
    return undefined;
  }
}
function collectCleanupResources(
  resources: z.infer<typeof inventorySchema>["StackResourceSummaries"],
) {
  const tables = new Set<string>();
  const logs = new Set<string>();
  for (const resource of resources) {
    const name = resource.PhysicalResourceId;
    if (!name && isMissingCleanupIdentity(resource)) return undefined;
    if (!name) continue;
    if (resource.ResourceType === "AWS::DynamoDB::Table") tables.add(name);
    if (resource.ResourceType === "AWS::Logs::LogGroup") logs.add(name);
    if (resource.ResourceType === "AWS::Lambda::Function") logs.add(`/aws/lambda/${name}`);
    if (resource.ResourceType === "AWS::CodeBuild::Project") logs.add(`/aws/codebuild/${name}`);
  }
  return { tableNames: [...tables], logGroupNames: [...logs] };
}
function isMissingCleanupIdentity(
  resource: z.infer<typeof inventorySchema>["StackResourceSummaries"][number],
): boolean {
  return (
    !["CREATE_FAILED", "DELETE_COMPLETE"].includes(resource.ResourceStatus) &&
    [
      "AWS::DynamoDB::Table",
      "AWS::Logs::LogGroup",
      "AWS::Lambda::Function",
      "AWS::CodeBuild::Project",
    ].includes(resource.ResourceType)
  );
}
async function ownedTable(
  context: TeardownContext,
  stack: PlatformStack,
  resource: z.infer<typeof inventorySchema>["StackResourceSummaries"][number],
  retention: string,
): Promise<OwnedTable | undefined> {
  const name = resource.PhysicalResourceId ?? "";
  if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(name))
    throw new Error("Invalid stack-owned table physical identity.");
  const arn = `arn:aws:dynamodb:${context.region}:${context.account}:table/${name}`;
  const result = await context.run([
    "dynamodb",
    "describe-table",
    "--table-name",
    name,
    "--region",
    context.region,
    "--output",
    "json",
  ]);
  if (result.code !== 0) {
    if (missing(result)) return undefined;
    throw new Error(`Cannot verify table ${arn}: ${result.stderr.trim()}`);
  }
  const { Table: table } = z
    .object({
      Table: z.object({
        TableArn: z.string(),
        TableName: z.string(),
        TableStatus: z.string(),
        DeletionProtectionEnabled: z.boolean(),
      }),
    })
    .parse(JSON.parse(result.stdout) as unknown);
  if (table.TableArn !== arn || table.TableName !== name || table.TableStatus !== "ACTIVE")
    throw new Error(
      `Table identity or readiness does not match ${arn}; no resources were removed.`,
    );
  const { Tags: tags } = z
    .object({
      Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
      NextToken: z.never().optional(),
    })
    .parse(await read(context, ["dynamodb", "list-tags-of-resource", "--resource-arn", arn]));
  if (
    !Object.entries(cloudStackTags(context.environment)).every(
      ([key, value]) => tags.filter((tag) => tag.Key === key && tag.Value === value).length === 1,
    )
  )
    throw new Error(`Table ownership tags do not match ${arn}; no resources were removed.`);
  for (const [key, value] of Object.entries({
    "aws:cloudformation:stack-id": stack.arn,
    "aws:cloudformation:logical-id": resource.LogicalResourceId,
  }))
    if (tags.some((tag) => tag.Key === key && tag.Value !== value))
      throw new Error(`Table CloudFormation ownership conflicts with ${arn}.`);
  return { name, arn, stackArn: stack.arn, retention, protected: table.DeletionProtectionEnabled };
}
function recoverStorageOutputs(
  stack: PlatformStack,
  template: z.infer<typeof templateSchema>,
): Readonly<Record<string, string>> {
  const outputs = { ...stack.outputs };
  for (const key of [
    "CloudControlDataBackend",
    "TursoDatabaseUrl",
    "TursoAuthTokenParameterName",
  ]) {
    const value = template.Outputs?.[key]?.Value;
    if (!outputs[key] && typeof value === "string") outputs[key] = value;
  }
  // Prior DynamoDB-only templates prove their provider through the three data outputs,
  // even when initial creation failed before any runtime Outputs were published.
  if (
    !outputs.CloudControlDataBackend &&
    ["Events", "Teams", "Deployments"].every((kind) => {
      const value = template.Outputs?.[`${kind}TableName`]?.Value;
      const ref = z.object({ Ref: z.string() }).safeParse(value);
      return ref.success && template.Resources[ref.data.Ref]?.Type === "AWS::DynamoDB::Table";
    })
  )
    outputs.CloudControlDataBackend = "dynamodb";
  return outputs;
}
function retainedResource(
  stack: PlatformStack,
  resource: z.infer<typeof inventorySchema>["StackResourceSummaries"][number],
  deletionPolicy: string | undefined,
): RetainedResource | undefined {
  if (deletionPolicy !== "Retain" && deletionPolicy !== "RetainExceptOnCreate") return undefined;
  if (!resource.PhysicalResourceId) {
    if (["CREATE_FAILED", "DELETE_COMPLETE"].includes(resource.ResourceStatus)) return undefined;
    throw new Error("Incomplete CloudFormation physical inventory; no resources were removed.");
  }
  return {
    logicalId: resource.LogicalResourceId,
    physicalId: resource.PhysicalResourceId,
    resourceType: resource.ResourceType,
    stackArn: stack.arn,
    deletionPolicy,
  };
}
async function discoverStack(context: TeardownContext, stack: PlatformStack) {
  const raw = z
    .object({ TemplateBody: z.unknown() })
    .parse(await read(context, ["cloudformation", "get-template", "--stack-name", stack.arn]));
  const template = templateSchema.parse(
    typeof raw.TemplateBody === "string"
      ? (JSON.parse(raw.TemplateBody) as unknown)
      : raw.TemplateBody,
  );
  const inventory = inventorySchema.parse(
    await read(context, ["cloudformation", "list-stack-resources", "--stack-name", stack.arn]),
  );
  const seen = new Set<string>();
  const tables: OwnedTable[] = [];
  const retainedResources: RetainedResource[] = [];
  for (const resource of inventory.StackResourceSummaries) {
    if (
      seen.has(resource.LogicalResourceId) ||
      template.Resources[resource.LogicalResourceId]?.Type !== resource.ResourceType ||
      resource.ResourceStatus.endsWith("_IN_PROGRESS")
    )
      throw new Error(
        "Ambiguous or changing CloudFormation inventory; wait and retry the read-only plan.",
      );
    seen.add(resource.LogicalResourceId);
    const retained = retainedResource(
      stack,
      resource,
      template.Resources[resource.LogicalResourceId]?.DeletionPolicy,
    );
    if (retained) retainedResources.push(retained);
    if (resource.ResourceType === "AWS::DynamoDB::Table" && resource.PhysicalResourceId) {
      const table = await ownedTable(
        context,
        stack,
        resource,
        template.Resources[resource.LogicalResourceId]?.DeletionPolicy ?? "Delete",
      );
      if (table) tables.push(table);
    }
  }
  const resources = collectCleanupResources(inventory.StackResourceSummaries);
  if (!resources)
    throw new Error("Incomplete CloudFormation physical inventory; no resources were removed.");
  return {
    tables,
    logGroups: resources.logGroupNames,
    retainedResources,
    outputs: recoverStorageOutputs(stack, template),
  };
}
/** Read-only physical ownership/protection proof. No data scans, prefix adoption or protection changes. */
export async function discoverTeardownPlan(context: TeardownContext): Promise<TeardownPlan> {
  const tables: OwnedTable[] = [];
  const logGroups = new Set<string>();
  const retainedResources: RetainedResource[] = [];
  const storageOutputs: Record<string, Readonly<Record<string, string>>> = {};
  for (const stack of context.stacks) {
    const discovered = await discoverStack(context, stack);
    tables.push(...discovered.tables);
    retainedResources.push(...discovered.retainedResources);
    for (const name of discovered.logGroups) logGroups.add(name);
    storageOutputs[stack.arn] = discovered.outputs;
  }
  if (new Set(tables.map((table) => table.arn)).size !== tables.length)
    throw new Error("A table appears in multiple stack inventories; ownership is ambiguous.");
  return {
    region: context.region,
    tables,
    logGroups: [...logGroups],
    retainedResources,
    storageOutputs,
  };
}
export function assertPurgeAllowed(plan: TeardownPlan): void {
  const protectedTables = plan.tables.filter((table) => table.protected);
  if (protectedTables.length > 0)
    throw new Error(
      `Purge stopped before mutation: deletion protection is enabled on ${protectedTables.map((table) => table.arn).join(", ")}. Review and authorize a targeted protection change separately; no protection was modified.`,
    );
}
export function showTeardownPlan(plan: TeardownPlan, stdout: (text: string) => void): void {
  stdout(
    `[cloud] Read-only ownership plan. Save this inventory before deleting stacks:\n${JSON.stringify(plan, null, 2)}\n`,
  );
  if (plan.tables.some((table) => table.protected))
    stdout(
      "[cloud] Deletion protection is enabled on a listed table. Source defaults cannot change deployed protection. No protection is changed by destroy or destroy-all. Review and explicitly authorize a targeted protection change for the exact table ARN, then rerun --plan before destroy-all.\n",
    );
}
export async function purgeStackOwnedResources(
  plan: TeardownPlan,
  run: TeardownContext["run"],
): Promise<void> {
  assertPurgeAllowed(plan);
  for (const table of plan.tables) {
    const deleted = await run([
      "dynamodb",
      "delete-table",
      "--table-name",
      table.name,
      "--region",
      plan.region,
    ]);
    if (deleted.code !== 0 && !missing(deleted))
      throw new Error(`Delete owned table ${table.arn} failed: ${deleted.stderr.trim()}`);
    if (deleted.code === 0) {
      const waited = await run([
        "dynamodb",
        "wait",
        "table-not-exists",
        "--table-name",
        table.name,
        "--region",
        plan.region,
      ]);
      if (waited.code !== 0)
        throw new Error(`Wait for table ${table.arn} deletion failed: ${waited.stderr.trim()}`);
    }
  }
  await purgeStackOwnedLogGroups(plan, run);
}
/** Reuse the captured exact log identities, including logs recreated during stack deletion. */
export async function purgeStackOwnedLogGroups(
  plan: Pick<TeardownPlan, "region" | "logGroups">,
  run: TeardownContext["run"],
): Promise<void> {
  for (const name of plan.logGroups) {
    const result = await run([
      "logs",
      "delete-log-group",
      "--log-group-name",
      name,
      "--region",
      plan.region,
    ]);
    if (result.code !== 0 && !missing(result))
      throw new Error(`Delete owned log group ${name} failed: ${result.stderr.trim()}`);
  }
}
