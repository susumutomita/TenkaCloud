import { z } from "zod";
import { assertHistoricalLiteTemplate } from "../../infrastructure/lib/cloud-hosting/historical-lite";
import type { PlatformStack } from "./failed-creation";
import type { ProcessResult } from "./process";
import { expectedStackTags } from "./stack-check";

interface TeardownContext {
  readonly account: string;
  readonly region: string;
  readonly environment: string;
  readonly stacks: readonly PlatformStack[];
  readonly run: (args: readonly string[]) => Promise<ProcessResult>;
  readonly bucketsOnly?: boolean;
  readonly purgeRetainedBuckets?: boolean;
}
interface OwnedBucket {
  readonly name: string;
  readonly logicalId: string;
  readonly stackArn: string;
  readonly retention: "Delete" | "Retain" | "RetainExceptOnCreate";
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
  readonly account: string;
  readonly environment: string;
  readonly region: string;
  readonly buckets: readonly OwnedBucket[];
  readonly tables: readonly OwnedTable[];
  readonly logGroups: readonly string[];
  readonly retainedResources: readonly RetainedResource[];
  readonly unverifiedDefaultLogGroups: readonly string[];
  readonly storageOutputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
type BucketContext = Pick<TeardownContext, "account" | "environment" | "region" | "run">;
const bucketPolicySchema = z.enum(["Delete", "Retain", "RetainExceptOnCreate"]);
const bucketObjectSchema = z.object({ Key: z.string().min(1), VersionId: z.string().min(1) });
const bucketPageSchema = z.object({
  IsTruncated: z.boolean(),
  Versions: z.array(bucketObjectSchema).default([]),
  DeleteMarkers: z.array(bucketObjectSchema).default([]),
});
// Drain one bounded service page at a time, then prove the bucket is empty.
const maxBucketPages = 10_000;
const maxDeletePayloadBytes = 64 * 1024;
const templateSchema = z.object({
  Resources: z.record(
    z.object({
      Type: z.string(),
      DeletionPolicy: z.string().optional(),
      Properties: z.record(z.unknown()).optional(),
    }),
  ),
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
async function bucketRequest(
  context: BucketContext,
  bucket: OwnedBucket,
  operation: string,
  args: readonly string[] = [],
): Promise<unknown> {
  const result = await context.run([
    "s3api",
    operation,
    "--bucket",
    bucket.name,
    "--expected-bucket-owner",
    context.account,
    ...args,
    "--region",
    context.region,
    "--output",
    "json",
  ]);
  if (result.code !== 0) {
    if (/\(NoSuchBucket\)/u.test(result.stderr)) return undefined;
    throw new Error(`S3 ${operation} for ${bucket.name} failed: ${result.stderr.trim()}`);
  }
  // The CLI emits no JSON for a successful quiet deletion with no per-object errors.
  if (operation === "delete-objects" && result.stdout.trim() === "") return {};
  return JSON.parse(result.stdout) as unknown;
}
async function verifyBucketOwnership(
  context: BucketContext,
  bucket: OwnedBucket,
): Promise<boolean> {
  const result = await bucketRequest(context, bucket, "get-bucket-tagging");
  if (result === undefined) return false;
  const { TagSet: tags } = z
    .object({ TagSet: z.array(z.object({ Key: z.string(), Value: z.string() })) })
    .parse(result);
  const expected = {
    ...expectedStackTags(context.environment, bucket.stackArn),
    "aws:cloudformation:stack-id": bucket.stackArn,
    "aws:cloudformation:logical-id": bucket.logicalId,
  };
  if (
    !Object.entries(expected).every(([key, value]) => {
      const matches = tags.filter((tag) => tag.Key === key);
      return matches.length === 1 && matches[0]?.Value === value;
    })
  )
    throw new Error(`Bucket ownership tags do not match ${bucket.name}; bucket cleanup stopped.`);
  return true;
}
async function ownedBucket(
  context: TeardownContext,
  stack: PlatformStack,
  resource: z.infer<typeof inventorySchema>["StackResourceSummaries"][number],
  policy: string | undefined,
): Promise<OwnedBucket | undefined> {
  if (resource.ResourceType !== "AWS::S3::Bucket" || resource.ResourceStatus === "DELETE_COMPLETE")
    return undefined;
  const name = resource.PhysicalResourceId;
  if (!name && resource.ResourceStatus === "CREATE_FAILED") return undefined;
  if (!name || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(name))
    throw new Error("Invalid stack-owned bucket physical identity.");
  const retention = bucketPolicySchema.parse(policy ?? "Delete");
  if (retention !== "Delete" && !context.purgeRetainedBuckets) return undefined;
  const bucket = { name, logicalId: resource.LogicalResourceId, stackArn: stack.arn, retention };
  return (await verifyBucketOwnership(context, bucket)) ? bucket : undefined;
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
    if (!name || resource.ResourceStatus === "DELETE_COMPLETE") continue;
    assertRuntimeIdentity(resource, name);
    if (resource.ResourceType === "AWS::DynamoDB::Table") tables.add(name);
    if (resource.ResourceType === "AWS::Logs::LogGroup") logs.add(name);
    if (resource.ResourceType === "AWS::Lambda::Function") logs.add(`/aws/lambda/${name}`);
    if (resource.ResourceType === "AWS::CodeBuild::Project") logs.add(`/aws/codebuild/${name}`);
  }
  return { tableNames: [...tables], logGroupNames: [...logs] };
}
function assertRuntimeIdentity(
  resource: z.infer<typeof inventorySchema>["StackResourceSummaries"][number],
  name: string,
): void {
  if (resource.ResourceType === "AWS::Lambda::Function" && !/^[A-Za-z0-9_-]{1,64}$/u.test(name))
    throw new Error("Invalid stack-owned Lambda physical identity.");
  if (
    resource.ResourceType === "AWS::CodeBuild::Project" &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/u.test(name)
  )
    throw new Error("Invalid stack-owned CodeBuild physical identity.");
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
  retention: string | undefined,
): Promise<OwnedTable | undefined> {
  if (
    context.bucketsOnly ||
    resource.ResourceType !== "AWS::DynamoDB::Table" ||
    !resource.PhysicalResourceId
  )
    return undefined;
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
    !Object.entries(expectedStackTags(context.environment, stack.arn)).every(
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
  return {
    name,
    arn,
    stackArn: stack.arn,
    retention: retention ?? "Delete",
    protected: table.DeletionProtectionEnabled,
  };
}
function recoverHistoricalProvider(
  stack: PlatformStack,
  rawTemplate: unknown,
  outputs: Record<string, string>,
): void {
  if (
    !outputs.CloudControlDataBackend &&
    (stack.name === "tenkacloud-lite" || stack.name.startsWith("tenkacloud-lite-"))
  ) {
    try {
      const provider = assertHistoricalLiteTemplate(
        rawTemplate,
        stack.name.includes("-problem-deploy") ? "backend" : "app",
      );
      outputs.CloudControlDataBackend = provider.kind;
      outputs.CloudComposition = "lite-baseline-v1";
      if (provider.kind === "turso") {
        outputs.TursoDatabaseUrl = provider.databaseUrl;
        outputs.TursoAuthTokenParameterName = provider.authTokenParameterName;
      }
    } catch (error) {
      // Ordinary owned-stack teardown still works without Outputs; an unproven external
      // database can never be selected for purge and its diagnostic is shown to the operator.
      outputs.CloudDataIdentityError = error instanceof Error ? error.message : String(error);
    }
  }
}
function recoverStorageOutputs(
  stack: PlatformStack,
  template: z.infer<typeof templateSchema>,
  rawTemplate: unknown,
): Readonly<Record<string, string>> {
  const outputs = { ...stack.outputs };
  for (const key of [
    "CloudComposition",
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
  recoverHistoricalProvider(stack, rawTemplate, outputs);
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
function assertStackIdentity(context: TeardownContext, stack: PlatformStack): void {
  const identity =
    /^arn:(?:aws|aws-us-gov|aws-cn):cloudformation:([^:]+):(\d{12}):stack\/([^/]+)\/[^/]+$/u.exec(
      stack.arn,
    );
  if (
    !identity ||
    identity[1] !== context.region ||
    identity[2] !== context.account ||
    identity[3] !== stack.name
  )
    throw new Error("Stack identity does not match the selected account and region.");
}
function assertStableInventory(
  template: z.infer<typeof templateSchema>,
  inventory: z.infer<typeof inventorySchema>,
): void {
  const seen = new Set<string>();
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
  }
}
async function discoverStack(context: TeardownContext, stack: PlatformStack) {
  assertStackIdentity(context, stack);
  const raw = z
    .object({ TemplateBody: z.unknown() })
    .parse(await read(context, ["cloudformation", "get-template", "--stack-name", stack.arn]));
  const rawTemplate =
    typeof raw.TemplateBody === "string"
      ? (JSON.parse(raw.TemplateBody) as unknown)
      : raw.TemplateBody;
  const template = templateSchema.parse(rawTemplate);
  const inventory = inventorySchema.parse(
    await read(context, ["cloudformation", "list-stack-resources", "--stack-name", stack.arn]),
  );
  assertStableInventory(template, inventory);
  const buckets: OwnedBucket[] = [];
  const tables: OwnedTable[] = [];
  const retainedResources: RetainedResource[] = [];
  for (const resource of inventory.StackResourceSummaries) {
    const retained = retainedResource(
      stack,
      resource,
      template.Resources[resource.LogicalResourceId]?.DeletionPolicy,
    );
    if (retained) retainedResources.push(retained);
    const bucket = await ownedBucket(
      context,
      stack,
      resource,
      template.Resources[resource.LogicalResourceId]?.DeletionPolicy,
    );
    if (bucket) buckets.push(bucket);
    const table = await ownedTable(
      context,
      stack,
      resource,
      template.Resources[resource.LogicalResourceId]?.DeletionPolicy,
    );
    if (table) tables.push(table);
  }
  const unverifiedDefaultLogGroups: string[] = [];
  const runtimeResources = inventory.StackResourceSummaries.filter((resource) => {
    const properties = template.Resources[resource.LogicalResourceId]?.Properties;
    const explicit =
      (resource.ResourceType === "AWS::Lambda::Function" &&
        properties?.LoggingConfig !== undefined) ||
      (resource.ResourceType === "AWS::CodeBuild::Project" && properties?.LogsConfig !== undefined);
    if (!explicit) return true;
    // A configured destination does not prove ownership of its previous default path.
    // CFN log groups are independently captured by their actual physical identities.
    const name = resource.PhysicalResourceId;
    if (name && resource.ResourceStatus !== "DELETE_COMPLETE") {
      assertRuntimeIdentity(resource, name);
      const service = resource.ResourceType === "AWS::Lambda::Function" ? "lambda" : "codebuild";
      unverifiedDefaultLogGroups.push(`/aws/${service}/${name}`);
    }
    return false;
  });
  const resources = collectCleanupResources(runtimeResources);
  if (!resources)
    throw new Error("Incomplete CloudFormation physical inventory; no resources were removed.");
  return {
    buckets,
    tables,
    logGroups: resources.logGroupNames,
    retainedResources,
    unverifiedDefaultLogGroups: unverifiedDefaultLogGroups.filter(
      (name) => !resources.logGroupNames.includes(name),
    ),
    outputs: recoverStorageOutputs(stack, template, rawTemplate),
  };
}
function retainedLogNames(resources: readonly RetainedResource[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const resource of resources) {
    if (resource.resourceType === "AWS::Logs::LogGroup") names.add(resource.physicalId);
    if (resource.resourceType === "AWS::Lambda::Function")
      names.add(`/aws/lambda/${resource.physicalId}`);
    if (resource.resourceType === "AWS::CodeBuild::Project")
      names.add(`/aws/codebuild/${resource.physicalId}`);
  }
  return names;
}
/** Read-only physical ownership/protection proof. No data scans, prefix adoption or protection changes. */
export async function discoverTeardownPlan(context: TeardownContext): Promise<TeardownPlan> {
  const buckets: OwnedBucket[] = [];
  const tables: OwnedTable[] = [];
  const logGroups = new Set<string>();
  const retainedResources: RetainedResource[] = [];
  const storageOutputs: Record<string, Readonly<Record<string, string>>> = {};
  const unverifiedDefaultLogGroups = new Set<string>();
  for (const stack of context.stacks) {
    // An in-flight deletion is only waited by the caller; never race its resource cleanup.
    if (stack.status === "DELETE_IN_PROGRESS") continue;
    const discovered = await discoverStack(context, stack);
    buckets.push(...discovered.buckets);
    tables.push(...discovered.tables);
    retainedResources.push(...discovered.retainedResources);
    for (const name of discovered.unverifiedDefaultLogGroups) unverifiedDefaultLogGroups.add(name);
    for (const name of discovered.logGroups) logGroups.add(name);
    storageOutputs[stack.arn] = discovered.outputs;
  }
  if (new Set(tables.map((table) => table.arn)).size !== tables.length)
    throw new Error("A table appears in multiple stack inventories; ownership is ambiguous.");
  if (new Set(buckets.map((bucket) => bucket.name)).size !== buckets.length)
    throw new Error("A bucket appears in multiple stack inventories; ownership is ambiguous.");
  // A default path derived in one stack must not bypass another selected stack's
  // exact CFN Retain policy. Apply the boundary after all inventories are merged.
  const retainedLogs = retainedLogNames(retainedResources);
  return {
    account: context.account,
    environment: context.environment,
    region: context.region,
    buckets,
    tables,
    logGroups: [...logGroups].filter(
      (name) => context.purgeRetainedBuckets || !retainedLogs.has(name),
    ),
    retainedResources,
    unverifiedDefaultLogGroups: [...unverifiedDefaultLogGroups].filter(
      (name) => !logGroups.has(name),
    ),
    storageOutputs,
  };
}
/** Empty exact, verified CFN buckets before CFN deletes them, including failed-create buckets. */
export async function emptyStackOwnedBuckets(
  plan: TeardownPlan,
  run: TeardownContext["run"],
  purgeRetainedBuckets = false,
): Promise<void> {
  if (!purgeRetainedBuckets && plan.buckets.some((bucket) => bucket.retention !== "Delete"))
    throw new Error("Retained bucket cleanup requires explicit purge authorization.");
  for (const bucket of plan.buckets) await emptyBucket({ ...plan, run }, bucket);
}
async function emptyBucket(context: BucketContext, bucket: OwnedBucket): Promise<void> {
  let previousPage = "";
  for (let pageNumber = 0; pageNumber < maxBucketPages; pageNumber += 1) {
    const result = await bucketRequest(context, bucket, "list-object-versions", [
      "--max-keys",
      "1000",
      "--no-paginate",
    ]);
    if (result === undefined) return;
    const page = bucketPageSchema.parse(result);
    const objects = [...page.Versions, ...page.DeleteMarkers];
    if (objects.length === 0 && !page.IsTruncated) return;
    if (objects.length === 0 || objects.length > 1000)
      throw new Error(`Invalid S3 version page for ${bucket.name}; bucket cleanup stopped.`);
    const signature = JSON.stringify(
      objects.map((item) => JSON.stringify(item)).sort((left, right) => left.localeCompare(right)),
    );
    if (signature === previousPage)
      throw new Error(`S3 cleanup made no progress for ${bucket.name}; stop writers and retry.`);
    previousPage = signature;
    if (!(await deleteBucketPage(context, bucket, objects))) return;
    // Restart at the first service page after deleting it. Following a cursor whose object
    // was just removed can skip versions; a fresh page also catches concurrent writes.
  }
  throw new Error(
    `S3 cleanup exceeded ${maxBucketPages} pages for ${bucket.name}; stop writers and retry.`,
  );
}
function bucketDeletePayloads(objects: readonly z.infer<typeof bucketObjectSchema>[]): string[] {
  const payloads: string[] = [];
  let batch: string[] = [];
  const envelopeBytes = Buffer.byteLength('{"Objects":[],"Quiet":true}');
  let bytes = envelopeBytes;
  for (const object of objects) {
    const encoded = JSON.stringify(object);
    const objectBytes = Buffer.byteLength(encoded);
    if (objectBytes + envelopeBytes > maxDeletePayloadBytes)
      throw new Error("S3 object identity exceeds the safe deletion payload size.");
    if (bytes + objectBytes + batch.length > maxDeletePayloadBytes) {
      payloads.push(`{"Objects":[${batch.join(",")}],"Quiet":true}`);
      batch = [];
      bytes = envelopeBytes;
    }
    batch.push(encoded);
    bytes += objectBytes;
  }
  if (batch.length > 0) payloads.push(`{"Objects":[${batch.join(",")}],"Quiet":true}`);
  return payloads;
}
async function deleteBucketPage(
  context: BucketContext,
  bucket: OwnedBucket,
  objects: readonly z.infer<typeof bucketObjectSchema>[],
): Promise<boolean> {
  // Keep each argv below the OS limit even when a page has 1,000 long or escaped keys.
  for (const payload of bucketDeletePayloads(objects)) {
    // Recheck tags immediately before each destructive request, as buckets can be recreated.
    if (!(await verifyBucketOwnership(context, bucket))) return false;
    const deleted = await bucketRequest(context, bucket, "delete-objects", ["--delete", payload]);
    if (deleted === undefined) return false;
    const { Errors: errors } = z
      .object({
        Errors: z
          .array(z.object({ Key: z.string(), Code: z.string(), Message: z.string().optional() }))
          .default([]),
      })
      .parse(deleted);
    if (errors.length > 0)
      throw new Error(`Delete objects from ${bucket.name} failed: ${JSON.stringify(errors)}`);
  }
  return true;
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
  if (plan.unverifiedDefaultLogGroups.length > 0)
    stdout(
      "[cloud] Listed unverifiedDefaultLogGroups are possible legacy default paths for runtimes with explicit logging configuration. They are not automatically deleted, including by destroy-all; verify actual existence, ownership, retention and references separately.\n",
    );
  if (plan.retainedResources.some((resource) => resource.resourceType === "AWS::Cognito::UserPool"))
    stdout(
      "[cloud] Listed retained Cognito pools remain under their deployed policy, including on destroy-all. Review each exact pool ID and its users before separately authorizing removal. External pools are outside this inventory; inspect CloudFormation failure events if a Delete-policy pool fails removal.\n",
    );
  stdout(
    "[cloud] Source archives in external buckets and shared CDKToolkit assets remain. Complete exercise teardown and verify archive ownership and references from all active events before separately authorizing cleanup. No bucket or prefix-wide archive deletion is performed.\n",
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
