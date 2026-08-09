import { spawn } from "node:child_process";
import type {
  AwsCommandError,
  CallerIdentityResult,
  LiteResidualInventoryAdapter,
  LiteResidualService,
  ObservedResource,
  ServiceInventory,
} from "./lite-residual-scan";

export interface AwsCliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type AwsCliRunner = (args: readonly string[]) => Promise<AwsCliResult>;

interface ParsedItems {
  readonly ok: true;
  readonly items: readonly Record<string, unknown>[];
}

interface ParseFailure {
  readonly ok: false;
  readonly message: string;
}

type ItemsResult = ParsedItems | ParseFailure;
interface TagsResult {
  readonly tags: Readonly<Record<string, string>> | undefined;
  readonly errors: readonly AwsCommandError[];
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactError(stderr: string): string {
  const compact = stderr.trim().replaceAll(/\s+/g, " ");
  return (compact || "AWS CLI returned no error text").slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function commandFailure(operation: string, result: AwsCliResult): AwsCommandError {
  return {
    code: "aws-command-failed",
    operation,
    message: `${compactError(result.stderr)} (exit ${result.code})`,
  };
}

function malformed(operation: string, message: string): AwsCommandError {
  return { code: "malformed-response", operation, message };
}

async function safelyRun(runAws: AwsCliRunner, args: readonly string[]): Promise<AwsCliResult> {
  try {
    return await runAws(args);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nextToken(record: Record<string, unknown>): string | undefined | null {
  const tokenKeys = ["NextToken", "nextToken", "ContinuationToken", "LastEvaluatedTableName"];
  const key = tokenKeys.find((candidate) => record[candidate] !== undefined);
  if (!key) return undefined;
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function parseObjectItems(record: Record<string, unknown>, key: string): ItemsResult {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    return { ok: false, message: `${key} must be an array of objects` };
  }
  return { ok: true, items: value.filter(isRecord) };
}

function parseStringItems(record: Record<string, unknown>, key: string): ItemsResult {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    return { ok: false, message: `${key} must be an array of non-empty strings` };
  }
  return {
    ok: true,
    items: value
      .filter((item): item is string => typeof item === "string")
      .map((item) => ({ id: item })),
  };
}

interface PageSpec {
  readonly operation: string;
  readonly baseArgs: readonly string[];
  readonly parseItems: (record: Record<string, unknown>) => ItemsResult;
}

async function collectPages(
  runAws: AwsCliRunner,
  spec: PageSpec,
): Promise<{
  readonly items: readonly Record<string, unknown>[];
  readonly errors: AwsCommandError[];
}> {
  const items: Record<string, unknown>[] = [];
  const errors: AwsCommandError[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;
  do {
    const args = [
      ...spec.baseArgs,
      "--max-items",
      "100",
      ...(token ? ["--starting-token", token] : []),
      "--output",
      "json",
      "--no-cli-pager",
    ];
    const result = await safelyRun(runAws, args);
    if (result.code !== 0) {
      errors.push(commandFailure(spec.operation, result));
      break;
    }
    const record = parseJsonObject(result.stdout);
    if (!record) {
      errors.push(malformed(spec.operation, "response must be a JSON object"));
      break;
    }
    const parsedItems = spec.parseItems(record);
    if (!parsedItems.ok) {
      errors.push(malformed(spec.operation, parsedItems.message));
      break;
    }
    items.push(...parsedItems.items);
    const parsedToken = nextToken(record);
    const tokenError = validatePageToken(spec.operation, parsedToken, seenTokens);
    if (tokenError) {
      errors.push(tokenError);
      break;
    }
    if (parsedToken) seenTokens.add(parsedToken);
    token = parsedToken ?? undefined;
  } while (token);
  return { items, errors };
}

function validatePageToken(
  operation: string,
  token: string | undefined | null,
  seenTokens: ReadonlySet<string>,
): AwsCommandError | undefined {
  if (token === null) return malformed(operation, "pagination token must be one non-empty string");
  if (!token || !seenTokens.has(token)) return undefined;
  return {
    code: "pagination-cycle",
    operation,
    message: `AWS returned pagination token ${token} more than once`,
  };
}

function parseTagArray(value: unknown, field: string, missingIsEmpty = true): TagsResult {
  if (value === undefined) {
    return missingIsEmpty
      ? { tags: {}, errors: [] }
      : { tags: undefined, errors: [malformed(field, `${field} field is required`)] };
  }
  if (!Array.isArray(value)) {
    return { tags: undefined, errors: [malformed(field, `${field} must be an array`)] };
  }
  const tags: Record<string, string> = {};
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.Key !== "string" ||
      item.Key === "" ||
      typeof item.Value !== "string" ||
      tags[item.Key] !== undefined
    ) {
      return {
        tags: undefined,
        errors: [malformed(field, `${field} contains an invalid or duplicate tag`)],
      };
    }
    tags[item.Key] = item.Value;
  }
  return { tags, errors: [] };
}

function parseTagMap(value: unknown, field: string, missingIsEmpty = true): TagsResult {
  if (value === undefined) {
    return missingIsEmpty
      ? { tags: {}, errors: [] }
      : { tags: undefined, errors: [malformed(field, `${field} field is required`)] };
  }
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    return { tags: undefined, errors: [malformed(field, `${field} must be a string map`)] };
  }
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (typeof tagValue === "string") tags[key] = tagValue;
  }
  return { tags, errors: [] };
}

function parseCodeBuildTagArray(value: unknown, field: string): TagsResult {
  if (value === undefined) return { tags: {}, errors: [] };
  if (!Array.isArray(value)) {
    return { tags: undefined, errors: [malformed(field, `${field} must be an array`)] };
  }
  const tags: Record<string, string> = {};
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      item.key === "" ||
      typeof item.value !== "string" ||
      tags[item.key] !== undefined
    ) {
      return {
        tags: undefined,
        errors: [malformed(field, `${field} contains an invalid or duplicate tag`)],
      };
    }
    tags[item.key] = item.value;
  }
  return { tags, errors: [] };
}

async function readTagArray(
  runAws: AwsCliRunner,
  operation: string,
  args: readonly string[],
  field: string,
  noTagSetIsEmpty = false,
): Promise<TagsResult> {
  const result = await safelyRun(runAws, [...args, "--output", "json", "--no-cli-pager"]);
  if (result.code !== 0) {
    if (noTagSetIsEmpty && /\bNoSuchTagSet\b/.test(result.stderr)) {
      return { tags: {}, errors: [] };
    }
    return { tags: undefined, errors: [commandFailure(operation, result)] };
  }
  const record = parseJsonObject(result.stdout);
  if (!record) {
    return { tags: undefined, errors: [malformed(operation, "response must be a JSON object")] };
  }
  // A successful dedicated tag API must return its documented field. S3's no-tag case is the
  // explicit NoSuchTagSet error handled above; a successful `{}` is malformed, not an empty set.
  const tags = parseTagArray(record[field], operation, false);
  return tags;
}

async function readTagMap(
  runAws: AwsCliRunner,
  operation: string,
  args: readonly string[],
  field: string,
): Promise<TagsResult> {
  const result = await safelyRun(runAws, [...args, "--output", "json", "--no-cli-pager"]);
  if (result.code !== 0) {
    return { tags: undefined, errors: [commandFailure(operation, result)] };
  }
  const record = parseJsonObject(result.stdout);
  if (!record) {
    return { tags: undefined, errors: [malformed(operation, "response must be a JSON object")] };
  }
  const tags = parseTagMap(record[field], operation, false);
  return tags;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function resourceWithTags(
  id: string,
  tagResult: TagsResult,
): { readonly resource: ObservedResource; readonly errors: readonly AwsCommandError[] } {
  return {
    resource: { id, ...(tagResult.tags ? { tags: tagResult.tags } : {}) },
    errors: tagResult.errors,
  };
}

async function scanCloudFormation(runAws: AwsCliRunner, region: string): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "cloudformation describe-stacks",
    baseArgs: ["cloudformation", "describe-stacks", "--region", region],
    parseItems: (record) => parseObjectItems(record, "Stacks"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const stack of listed.items) {
    const id = nonEmptyString(stack, "StackName");
    if (!id) {
      errors.push(malformed("cloudformation describe-stacks", "StackName must be non-empty"));
      continue;
    }
    const tagResult = parseTagArray(stack.Tags, `cloudformation stack ${id} Tags`);
    resources.push({ id, ...(tagResult.tags ? { tags: tagResult.tags } : {}) });
    errors.push(...tagResult.errors);
  }
  return { resources, errors };
}

async function readDynamoTags(
  runAws: AwsCliRunner,
  tableName: string,
  region: string,
): Promise<TagsResult> {
  const described = await safelyRun(runAws, [
    "dynamodb",
    "describe-table",
    "--table-name",
    tableName,
    "--region",
    region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  if (described.code !== 0) {
    return {
      tags: undefined,
      errors: [commandFailure(`dynamodb describe-table ${tableName}`, described)],
    };
  }
  const root = parseJsonObject(described.stdout);
  const table = root && isRecord(root.Table) ? root.Table : undefined;
  const arn = table && nonEmptyString(table, "TableArn");
  if (!arn) {
    return {
      tags: undefined,
      errors: [
        malformed(`dynamodb describe-table ${tableName}`, "Table.TableArn must be non-empty"),
      ],
    };
  }
  const pages = await collectPages(runAws, {
    operation: `dynamodb list-tags-of-resource ${tableName}`,
    baseArgs: ["dynamodb", "list-tags-of-resource", "--resource-arn", arn, "--region", region],
    parseItems: (record) => parseObjectItems(record, "Tags"),
  });
  if (pages.errors.length > 0) return { tags: undefined, errors: pages.errors };
  return parseTagArray(pages.items, `dynamodb table ${tableName} Tags`);
}

async function scanDynamoDb(runAws: AwsCliRunner, region: string): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "dynamodb list-tables",
    baseArgs: ["dynamodb", "list-tables", "--region", region],
    parseItems: (record) => parseStringItems(record, "TableNames"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const item of listed.items) {
    const id = nonEmptyString(item, "id");
    if (!id) continue;
    const tagged = resourceWithTags(id, await readDynamoTags(runAws, id, region));
    resources.push(tagged.resource);
    errors.push(...tagged.errors);
  }
  return { resources, errors };
}

async function scanS3(
  runAws: AwsCliRunner,
  accountId: string,
  region: string,
): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "s3api list-buckets",
    baseArgs: ["s3api", "list-buckets", "--bucket-region", region, "--region", region],
    parseItems: (record) => parseObjectItems(record, "Buckets"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const bucket of listed.items) {
    const id = nonEmptyString(bucket, "Name");
    if (!id) {
      errors.push(malformed("s3api list-buckets", "Buckets[].Name must be non-empty"));
      continue;
    }
    const tags = await readTagArray(
      runAws,
      `s3api get-bucket-tagging ${id}`,
      [
        "s3api",
        "get-bucket-tagging",
        "--bucket",
        id,
        "--expected-bucket-owner",
        accountId,
        "--region",
        region,
      ],
      "TagSet",
      true,
    );
    const tagged = resourceWithTags(id, tags);
    resources.push(tagged.resource);
    errors.push(...tagged.errors);
  }
  return { resources, errors };
}

async function scanLogs(runAws: AwsCliRunner, region: string): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "logs describe-log-groups",
    baseArgs: ["logs", "describe-log-groups", "--region", region],
    parseItems: (record) => parseObjectItems(record, "logGroups"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const group of listed.items) {
    const id = nonEmptyString(group, "logGroupName");
    const arn =
      nonEmptyString(group, "logGroupArn") ?? nonEmptyString(group, "arn")?.replace(/:\*$/, "");
    if (!id || !arn) {
      errors.push(
        malformed("logs describe-log-groups", "logGroupName and logGroupArn/arn must be non-empty"),
      );
      continue;
    }
    const tags = await readTagMap(
      runAws,
      `logs list-tags-for-resource ${id}`,
      ["logs", "list-tags-for-resource", "--resource-arn", arn, "--region", region],
      "tags",
    );
    const tagged = resourceWithTags(id, tags);
    resources.push(tagged.resource);
    errors.push(...tagged.errors);
  }
  return { resources, errors };
}

async function scanSns(runAws: AwsCliRunner, region: string): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "sns list-topics",
    baseArgs: ["sns", "list-topics", "--region", region],
    parseItems: (record) => parseObjectItems(record, "Topics"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const topic of listed.items) {
    const id = nonEmptyString(topic, "TopicArn");
    if (!id) {
      errors.push(malformed("sns list-topics", "Topics[].TopicArn must be non-empty"));
      continue;
    }
    const tags = await readTagArray(
      runAws,
      `sns list-tags-for-resource ${id}`,
      ["sns", "list-tags-for-resource", "--resource-arn", id, "--region", region],
      "Tags",
    );
    const tagged = resourceWithTags(id, tags);
    resources.push(tagged.resource);
    errors.push(...tagged.errors);
  }
  return { resources, errors };
}

async function scanBudgets(
  runAws: AwsCliRunner,
  accountId: string,
  region: string,
  partition: string,
): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "budgets describe-budgets",
    baseArgs: ["budgets", "describe-budgets", "--account-id", accountId, "--region", region],
    parseItems: (record) => parseObjectItems(record, "Budgets"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  for (const budget of listed.items) {
    const id = nonEmptyString(budget, "BudgetName");
    if (!id) {
      errors.push(malformed("budgets describe-budgets", "Budgets[].BudgetName must be non-empty"));
      continue;
    }
    const arn = `arn:${partition}:budgets::${accountId}:budget/${id}`;
    const tags = await readTagArray(
      runAws,
      `budgets list-tags-for-resource ${id}`,
      ["budgets", "list-tags-for-resource", "--resource-arn", arn, "--region", region],
      "ResourceTags",
    );
    const tagged = resourceWithTags(id, tags);
    resources.push(tagged.resource);
    errors.push(...tagged.errors);
  }
  return { resources, errors };
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

function codeBuildBatchFailure(batch: readonly string[], error: AwsCommandError): ServiceInventory {
  return { resources: batch.map((id) => ({ id })), errors: [error] };
}

function parseOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function isUnseenBatchId(
  id: string | undefined,
  batch: readonly string[],
  seen: ReadonlySet<string>,
): id is string {
  return id !== undefined && batch.includes(id) && !seen.has(id);
}

function parseCodeBuildBatch(
  root: Record<string, unknown>,
  batch: readonly string[],
): ServiceInventory {
  const projects = parseObjectItems(root, "projects");
  const missing = parseOptionalStringArray(root.projectsNotFound);
  if (!projects.ok || !missing) {
    return codeBuildBatchFailure(
      batch,
      malformed("codebuild batch-get-projects", "projects/projectsNotFound are malformed"),
    );
  }
  const resources: ObservedResource[] = [];
  const errors: AwsCommandError[] = [];
  const seen = new Set<string>();
  if (missing.length > 0) {
    errors.push(
      malformed(
        "codebuild batch-get-projects",
        `projects disappeared during inventory: ${missing.join(", ")}`,
      ),
    );
  }
  for (const project of projects.items) {
    const id = nonEmptyString(project, "name");
    if (!isUnseenBatchId(id, batch, seen)) {
      errors.push(
        malformed(
          "codebuild batch-get-projects",
          "project name was missing, duplicate, or unrequested",
        ),
      );
      continue;
    }
    seen.add(id);
    const tags = parseCodeBuildTagArray(project.tags, `codebuild project ${id} tags`);
    resources.push({ id, ...(tags.tags ? { tags: tags.tags } : {}) });
    errors.push(...tags.errors);
  }
  for (const id of missing) {
    if (!batch.includes(id) || seen.has(id)) {
      errors.push(
        malformed("codebuild batch-get-projects", "projectsNotFound contained an invalid ID"),
      );
      continue;
    }
    seen.add(id);
    resources.push({ id });
  }
  for (const id of batch) {
    if (seen.has(id)) continue;
    errors.push(
      malformed("codebuild batch-get-projects", `project ${id} was omitted from the response`),
    );
    resources.push({ id });
  }
  return { resources, errors };
}

async function inspectCodeBuildBatch(
  runAws: AwsCliRunner,
  batch: readonly string[],
  region: string,
): Promise<ServiceInventory> {
  const result = await safelyRun(runAws, [
    "codebuild",
    "batch-get-projects",
    "--names",
    ...batch,
    "--region",
    region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  if (result.code !== 0) {
    return codeBuildBatchFailure(batch, commandFailure("codebuild batch-get-projects", result));
  }
  const root = parseJsonObject(result.stdout);
  if (!root) {
    return codeBuildBatchFailure(
      batch,
      malformed("codebuild batch-get-projects", "response must be a JSON object"),
    );
  }
  return parseCodeBuildBatch(root, batch);
}

async function scanCodeBuild(runAws: AwsCliRunner, region: string): Promise<ServiceInventory> {
  const listed = await collectPages(runAws, {
    operation: "codebuild list-projects",
    baseArgs: ["codebuild", "list-projects", "--region", region],
    parseItems: (record) => parseStringItems(record, "projects"),
  });
  const resources: ObservedResource[] = [];
  const errors = [...listed.errors];
  const names = listed.items.flatMap((item) => {
    const id = nonEmptyString(item, "id");
    return id ? [id] : [];
  });
  for (const batch of chunks(names, 100)) {
    const inventory = await inspectCodeBuildBatch(runAws, batch, region);
    resources.push(...inventory.resources);
    errors.push(...inventory.errors);
  }
  return { resources, errors };
}

async function getCallerIdentity(
  runAws: AwsCliRunner,
  region: string,
): Promise<CallerIdentityResult> {
  const result = await safelyRun(runAws, [
    "sts",
    "get-caller-identity",
    "--region",
    region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  if (result.code !== 0)
    return { ok: false, error: commandFailure("sts get-caller-identity", result) };
  const root = parseJsonObject(result.stdout);
  const accountId = root && nonEmptyString(root, "Account");
  const arn = root && nonEmptyString(root, "Arn");
  const arnParts = arn?.split(":");
  const partition = arnParts?.[0] === "arn" ? arnParts[1] : undefined;
  const service = arnParts?.[2];
  const arnAccountId = arnParts?.[4];
  const resource = arnParts?.slice(5).join(":");
  if (
    !accountId ||
    !/^\d{12}$/.test(accountId) ||
    !arn ||
    !partition ||
    (service !== "iam" && service !== "sts") ||
    arnAccountId !== accountId ||
    !resource
  ) {
    return {
      ok: false,
      error: malformed(
        "sts get-caller-identity",
        "Account must be 12 digits and match a valid IAM/STS Arn",
      ),
    };
  }
  return { ok: true, identity: { accountId, arn, partition } };
}

export function createAwsCliLiteResidualInventory(
  runAws: AwsCliRunner,
): LiteResidualInventoryAdapter {
  return {
    getCallerIdentity: (region) => getCallerIdentity(runAws, region),
    scanService: (service, input) => {
      const scans: Readonly<Record<LiteResidualService, () => Promise<ServiceInventory>>> = {
        cloudformation: () => scanCloudFormation(runAws, input.region),
        dynamodb: () => scanDynamoDb(runAws, input.region),
        s3: () => scanS3(runAws, input.accountId, input.region),
        logs: () => scanLogs(runAws, input.region),
        sns: () => scanSns(runAws, input.region),
        budgets: () => scanBudgets(runAws, input.accountId, input.region, input.partition),
        codebuild: () => scanCodeBuild(runAws, input.region),
      };
      return scans[service]();
    },
  };
}

/** Real read-only AWS CLI edge. No command in this adapter mutates a resource. */
export function runAwsCli(args: readonly string[]): Promise<AwsCliResult> {
  return new Promise((resolve) => {
    // The AWS CLI has no stable install path across brew/apt/pip/asdf; operator PATH is required.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- read-only operator CLI edge
    const child = spawn("aws", [...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
  });
}
