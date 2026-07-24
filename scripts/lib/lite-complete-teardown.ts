export interface StackOwnedCleanupResources {
  readonly tableNames: readonly string[];
  readonly logGroupNames: readonly string[];
}

interface SpawnCaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CompleteTeardownIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly spawnCapture: (cmd: string, args: readonly string[]) => Promise<SpawnCaptureResult>;
}

interface CompleteTeardownInput {
  readonly stackNames: readonly string[];
  readonly environment: string;
  readonly includeLegacyLauncherLogGroup: boolean;
  readonly io: CompleteTeardownIO;
}

type ParsedCleanupResource =
  | { readonly kind: "table"; readonly physicalId: string }
  | { readonly kind: "logGroup"; readonly logGroupName: string }
  | { readonly kind: "unrelated" };

const CLEANUP_RESOURCE_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::CodeBuild::Project",
  "AWS::Lambda::Function",
  "AWS::Logs::LogGroup",
]);

function parseCleanupResource(summary: unknown): ParsedCleanupResource | undefined {
  if (typeof summary !== "object" || summary === null) return undefined;
  const resourceType =
    "ResourceType" in summary && typeof summary.ResourceType === "string"
      ? summary.ResourceType
      : undefined;
  if (!resourceType || !CLEANUP_RESOURCE_TYPES.has(resourceType)) {
    return { kind: "unrelated" };
  }
  const physicalId =
    "PhysicalResourceId" in summary && typeof summary.PhysicalResourceId === "string"
      ? summary.PhysicalResourceId.trim()
      : "";
  if (!physicalId) return undefined;
  if (resourceType === "AWS::CodeBuild::Project") {
    return { kind: "logGroup", logGroupName: `/aws/codebuild/${physicalId}` };
  }
  if (resourceType === "AWS::Lambda::Function") {
    return { kind: "logGroup", logGroupName: `/aws/lambda/${physicalId}` };
  }
  if (resourceType === "AWS::Logs::LogGroup") {
    return { kind: "logGroup", logGroupName: physicalId };
  }
  return { kind: "table", physicalId };
}

/**
 * Extract only physical IDs that CloudFormation proves belong to a Lite stack.
 *
 * Prefix scans can overlap other environments and SaaS, so destructive cleanup
 * accepts only exact table/log names or default log names derived from captured
 * Lambda and CodeBuild physical IDs.
 */
export function parseStackOwnedCleanupResources(
  stdout: string,
): StackOwnedCleanupResources | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("StackResourceSummaries" in parsed) ||
    !Array.isArray(parsed.StackResourceSummaries)
  ) {
    return undefined;
  }

  const tableNames = new Set<string>();
  const logGroupNames = new Set<string>();
  for (const summary of parsed.StackResourceSummaries) {
    const resource = parseCleanupResource(summary);
    if (!resource) return undefined;
    if (resource.kind === "table") tableNames.add(resource.physicalId);
    if (resource.kind === "logGroup") logGroupNames.add(resource.logGroupName);
  }
  return {
    tableNames: [...tableNames],
    logGroupNames: [...logGroupNames],
  };
}

function isAlreadyMissing(result: SpawnCaptureResult): boolean {
  return /ResourceNotFoundException|does not exist|not found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

async function discoverStackOwnedCleanupResources(
  input: CompleteTeardownInput,
): Promise<{ readonly code: number; readonly resources?: StackOwnedCleanupResources }> {
  const { io } = input;
  const tableNames = new Set<string>();
  const logGroupNames = new Set<string>();
  let discoveredStackCount = 0;
  for (const stackName of input.stackNames) {
    const result = await io.spawnCapture("aws", [
      "cloudformation",
      "list-stack-resources",
      "--stack-name",
      stackName,
      "--output",
      "json",
    ]);
    if (result.code !== 0) {
      if (isAlreadyMissing(result)) {
        io.stdout(`[lite] stack ${stackName} is already absent; continuing recovery.\n`);
        continue;
      }
      io.stderr(
        `[lite] complete-teardown ownership discovery failed for ${stackName}: ${result.stderr}\n`,
      );
      return { code: result.code || 1 };
    }
    discoveredStackCount += 1;
    const parsed = parseStackOwnedCleanupResources(result.stdout);
    if (!parsed) {
      io.stderr(
        `[lite] complete-teardown ownership discovery failed for ${stackName}: malformed CloudFormation response\n`,
      );
      return { code: 1 };
    }
    for (const tableName of parsed.tableNames) tableNames.add(tableName);
    for (const logGroupName of parsed.logGroupNames) logGroupNames.add(logGroupName);
  }
  if (discoveredStackCount === 0) {
    io.stderr(
      "[lite] complete-teardown ownership discovery failed: every Lite stack is absent; " +
        "retained resource ownership cannot be proven.\n",
    );
    return { code: 1 };
  }

  // Pre-managed launcher templates used the default CodeBuild log group. The
  // updated launcher opts in only after moving the active build to a distinct,
  // CloudFormation-managed group, so deleting this exact legacy name is safe.
  if (input.includeLegacyLauncherLogGroup) {
    logGroupNames.add(`/aws/codebuild/tenkacloud-lite-${input.environment}`);
  }
  const resources = {
    tableNames: [...tableNames],
    logGroupNames: [...logGroupNames],
  };
  io.stdout(
    `[lite] complete teardown owns ${resources.tableNames.length} DynamoDB table(s) and ` +
      `${resources.logGroupNames.length} CloudWatch log group(s).\n`,
  );
  return { code: 0, resources };
}

async function deleteStackOwnedTable(tableName: string, io: CompleteTeardownIO): Promise<number> {
  io.stdout(`[lite] deleting stack-owned DynamoDB table ${tableName}...\n`);
  const deleted = await io.spawnCapture("aws", [
    "dynamodb",
    "delete-table",
    "--table-name",
    tableName,
  ]);
  if (deleted.code !== 0) {
    if (isAlreadyMissing(deleted)) return 0;
    io.stderr(`[lite] failed to delete DynamoDB table ${tableName}: ${deleted.stderr}\n`);
    return deleted.code || 1;
  }
  const waited = await io.spawnCapture("aws", [
    "dynamodb",
    "wait",
    "table-not-exists",
    "--table-name",
    tableName,
  ]);
  if (waited.code === 0) return 0;
  io.stderr(
    `[lite] timed out waiting for DynamoDB table ${tableName} deletion: ${waited.stderr}\n`,
  );
  return waited.code || 1;
}

async function deleteStackOwnedLogGroup(
  logGroupName: string,
  io: CompleteTeardownIO,
): Promise<number> {
  io.stdout(`[lite] deleting stack-owned CloudWatch log group ${logGroupName}...\n`);
  const deleted = await io.spawnCapture("aws", [
    "logs",
    "delete-log-group",
    "--log-group-name",
    logGroupName,
  ]);
  if (deleted.code === 0 || isAlreadyMissing(deleted)) return 0;
  io.stderr(`[lite] failed to delete log group ${logGroupName}: ${deleted.stderr}\n`);
  return deleted.code || 1;
}

async function purgeStackOwnedResources(
  resources: StackOwnedCleanupResources,
  io: CompleteTeardownIO,
): Promise<number> {
  for (const tableName of resources.tableNames) {
    const code = await deleteStackOwnedTable(tableName, io);
    if (code !== 0) return code;
  }
  for (const logGroupName of resources.logGroupNames) {
    const code = await deleteStackOwnedLogGroup(logGroupName, io);
    if (code !== 0) return code;
  }
  return 0;
}

export async function purgeLiteStackOwnedResources(input: CompleteTeardownInput): Promise<number> {
  const discovery = await discoverStackOwnedCleanupResources(input);
  if (!discovery.resources) return discovery.code;
  return purgeStackOwnedResources(discovery.resources, input.io);
}
