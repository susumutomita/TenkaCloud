import { createHash } from "node:crypto";
import { type CloudDeploymentInput, deploymentIdentity, parseDeploymentInput } from "./input.js";
import type {
  AssumedCredentials,
  CloudFormationTransport,
  CloudRunnerDependencies,
  StackDescription,
  StackTag,
} from "./transports.js";

export {
  type CloudDeploymentInput,
  deploymentIdentity,
  MAX_DEPLOYMENT_INPUT_BYTES,
  parseDeploymentInput,
  serializeDeploymentInput,
} from "./input.js";
export type {
  AssumedCredentials,
  CloudFormationTransport,
  CloudRunnerDependencies,
  SsmTransport,
  StackDescription,
  StackTag,
  StsTransport,
} from "./transports.js";

export interface DeploymentReference {
  readonly stackId: string;
  readonly fingerprint: string;
}

export interface DeploymentObservation {
  readonly reference: DeploymentReference;
  readonly phase: "pending" | "ready" | "failed";
  readonly stackStatus: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface CreateDeploymentResult extends DeploymentObservation {
  readonly operation: "created" | "existing";
}

export interface DeletionObservation {
  readonly reference?: DeploymentReference;
  readonly phase: "waiting" | "pending" | "deleted" | "failed";
  readonly stackStatus: string;
}

/** Ownership includes the complete immutable request, not just a display name or team slug. */
export function deploymentOwnershipTags(input: CloudDeploymentInput): readonly StackTag[] {
  const values = {
    EventId: input.eventId,
    TeamId: input.teamId,
    ProblemId: input.problemId,
    JobId: input.jobId,
    AttemptId: input.attemptId,
    AccountId: input.target.accountId,
    Region: input.target.region,
    RequestFingerprint: deploymentIdentity(input).fingerprint,
  };
  return Object.freeze(
    Object.entries(values).map(([name, Value]) =>
      Object.freeze({ Key: `TenkaCloud:${name}`, Value }),
    ),
  );
}

async function assumeDeploymentRole(
  input: CloudDeploymentInput,
  deps: CloudRunnerDependencies,
): Promise<AssumedCredentials> {
  const parameterArn = input.target.externalIdParameterArn;
  const parameterRegion = parameterArn.split(":")[3];
  if (!parameterRegion) throw new Error("ExternalId parameter region is required");
  const result = await deps.ssm(parameterRegion).getParameter({
    Name: parameterArn,
    WithDecryption: true,
  });
  const parameter = result.Parameter;
  if (
    parameter?.ARN !== parameterArn ||
    parameter.Type !== "SecureString" ||
    !parameter.Value ||
    !/^[\w+=,.@:/-]{2,1224}$/.test(parameter.Value)
  ) {
    throw new Error("A matching SecureString ExternalId parameter is required");
  }
  // No old-generation fallback: operators must explicitly repair a rotated binding.
  const response = await deps.sts.assumeRole({
    RoleArn: input.target.roleArn,
    RoleSessionName: `tc-${deploymentIdentity(input).fingerprint.slice(0, 48)}`,
    ExternalId: parameter.Value,
    DurationSeconds: 900,
  });
  const credentials = response.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken ||
    !(credentials.Expiration instanceof Date) ||
    !Number.isFinite(credentials.Expiration.getTime()) ||
    credentials.Expiration.getTime() <= (deps.now ?? Date.now)() + 60_000
  ) {
    throw new Error("AssumeRole returned incomplete or expired credentials");
  }
  return Object.freeze({
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: new Date(credentials.Expiration),
  });
}

async function connect(input: CloudDeploymentInput, deps: CloudRunnerDependencies) {
  const credentials = await assumeDeploymentRole(input, deps);
  return deps.cloudFormation({
    region: input.target.region,
    accountId: input.target.accountId,
    credentials,
  });
}

function assertStackId(input: CloudDeploymentInput, stackId: string | undefined): string {
  const { stackName } = deploymentIdentity(input);
  const prefix = `arn:aws:cloudformation:${input.target.region}:${input.target.accountId}:stack/${stackName}/`;
  if (!stackId?.startsWith(prefix) || !/^[A-Za-z0-9-]+$/.test(stackId.slice(prefix.length))) {
    throw new Error("CloudFormation stack identity does not match the deployment target");
  }
  return stackId;
}

function assertOwnership(input: CloudDeploymentInput, stack: StackDescription): string {
  const stackId = assertStackId(input, stack.StackId);
  if (stack.StackName !== deploymentIdentity(input).stackName) {
    throw new Error("CloudFormation stack name does not match the deployment target");
  }
  const tags = stack.Tags ?? [];
  for (const required of deploymentOwnershipTags(input)) {
    const matches = tags.filter((tag) => tag.Key === required.Key);
    if (matches.length !== 1 || matches[0]?.Value !== required.Value) {
      throw new Error("CloudFormation stack ownership does not match the immutable deployment");
    }
  }
  return stackId;
}

function stackAbsent(error: unknown, stackName: string): boolean {
  return (
    error instanceof Error &&
    error.name === "ValidationError" &&
    error.message === `Stack with id ${stackName} does not exist`
  );
}

async function lookupStack(
  cfn: CloudFormationTransport,
  name: string,
): Promise<StackDescription | undefined> {
  let result: Awaited<ReturnType<CloudFormationTransport["describeStacks"]>>;
  try {
    result = await cfn.describeStacks({ StackName: name });
  } catch (error) {
    if (stackAbsent(error, name)) return undefined;
    throw error;
  }
  if (result.Stacks?.length !== 1 || !result.Stacks[0]) {
    throw new Error("CloudFormation returned an ambiguous stack description");
  }
  return result.Stacks[0];
}

const pendingStatuses = new Set(["CREATE_IN_PROGRESS", "ROLLBACK_IN_PROGRESS"]);
const failedStatuses = new Set([
  "CREATE_FAILED",
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "DELETE_IN_PROGRESS",
  "DELETE_FAILED",
  "DELETE_COMPLETE",
]);

function stackPhase(status: string | undefined): DeploymentObservation["phase"] {
  if (status === "CREATE_COMPLETE") return "ready";
  if (status && pendingStatuses.has(status)) return "pending";
  if (status && failedStatuses.has(status)) return "failed";
  throw new Error("Unexpected status for a create-only CloudFormation deployment");
}

function allowedOutputs(input: CloudDeploymentInput, stack: StackDescription) {
  const outputs: Record<string, string> = {};
  for (const key of input.allowedOutputKeys) {
    const matches = (stack.Outputs ?? []).filter((entry) => entry.OutputKey === key);
    if (matches.length > 1) throw new Error("CloudFormation returned duplicate allowed outputs");
    const value = matches[0]?.OutputValue;
    if (value === undefined) continue;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) {
      throw new Error("CloudFormation output exceeds the value limit");
    }
    Object.defineProperty(outputs, key, { value, enumerable: true });
  }
  if (Buffer.byteLength(JSON.stringify(outputs), "utf8") > 16_384) {
    throw new Error("CloudFormation outputs exceed the serialized limit");
  }
  return Object.freeze(outputs);
}

function observation(input: CloudDeploymentInput, stack: StackDescription): DeploymentObservation {
  const stackId = assertOwnership(input, stack);
  const phase = stackPhase(stack.StackStatus);
  return Object.freeze({
    reference: Object.freeze({ stackId, fingerprint: deploymentIdentity(input).fingerprint }),
    phase,
    stackStatus: stack.StackStatus ?? "",
    outputs: phase === "ready" ? allowedOutputs(input, stack) : Object.freeze({}),
  });
}

/** Submit once, or resume exactly the same owned attempt. Never updates/deletes a stack. */
export async function createDeployment(
  value: unknown,
  deps: CloudRunnerDependencies,
): Promise<CreateDeploymentResult> {
  const input = parseDeploymentInput(value);
  const identity = deploymentIdentity(input);
  const cfn = await connect(input, deps);
  const existing = await lookupStack(cfn, identity.stackName);
  if (existing) return Object.freeze({ ...observation(input, existing), operation: "existing" });
  let created: Awaited<ReturnType<CloudFormationTransport["createStack"]>>;
  try {
    created = await cfn.createStack({
      StackName: identity.stackName,
      TemplateBody: input.templateBody,
      Parameters: input.parameters.map(({ key, value: ParameterValue }) => ({
        ParameterKey: key,
        ParameterValue,
      })),
      Capabilities: input.capabilities,
      Tags: deploymentOwnershipTags(input),
      ClientRequestToken: identity.clientRequestToken,
      OnFailure: "DO_NOTHING",
      TimeoutInMinutes: 30,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AlreadyExistsException") throw error;
    const raced = await lookupStack(cfn, identity.stackName);
    if (!raced) throw new Error("Concurrent CloudFormation create is not yet observable");
    return Object.freeze({ ...observation(input, raced), operation: "existing" });
  }
  const stackId = assertStackId(input, created.StackId);
  return Object.freeze({
    reference: Object.freeze({ stackId, fingerprint: identity.fingerprint }),
    operation: "created",
    phase: "pending",
    stackStatus: "CREATE_IN_PROGRESS",
    outputs: Object.freeze({}),
  });
}

/** One poll, suitable for a durable orchestrator. No credentials or raw AWS response escapes. */
export async function describeDeployment(
  value: unknown,
  reference: DeploymentReference,
  deps: CloudRunnerDependencies,
): Promise<DeploymentObservation> {
  const input = parseDeploymentInput(value);
  const { stack } = await ownedStack(input, reference, deps);
  return observation(input, stack);
}

async function ownedStack(
  input: CloudDeploymentInput,
  reference: DeploymentReference,
  deps: CloudRunnerDependencies,
) {
  const stackId = assertStackId(input, reference.stackId);
  if (reference.fingerprint !== deploymentIdentity(input).fingerprint) {
    throw new Error("Deployment reference does not match the immutable input");
  }
  const cfn = await connect(input, deps);
  const stack = await lookupStack(cfn, stackId);
  if (!stack) throw new Error("Previously created CloudFormation stack is missing");
  if (stack.StackId !== stackId) throw new Error("CloudFormation replaced the deployment stack");
  assertOwnership(input, stack);
  return { cfn, stack };
}

/** Read-only access to the canonical hello-world viewer; never changes the pinned request. */
export async function describeParticipantTarget(
  value: unknown,
  reference: DeploymentReference,
  deps: CloudRunnerDependencies,
) {
  const input = parseDeploymentInput(value);
  const name = deploymentIdentity(input).stackName;
  if (
    input.problemId !== "hello-world" ||
    input.parameters.find((entry) => entry.key === "NamePrefix")?.value !== name ||
    input.parameters.find((entry) => entry.key === "ExternalId")?.value !== input.jobId
  )
    throw new Error("Participant access requires the canonical hello-world deployment");
  const { cfn, stack } = await ownedStack(input, reference, deps);
  if (stack.StackStatus !== "CREATE_COMPLETE" || !cfn.describeStackResource)
    throw new Error("Participant stack is not ready");
  const result = await cfn.describeStackResource({
    StackName: reference.stackId,
    LogicalResourceId: "ParticipantViewerRole",
  });
  const role = result.StackResourceDetail;
  if (
    role?.StackId !== reference.stackId ||
    role.LogicalResourceId !== "ParticipantViewerRole" ||
    role.ResourceType !== "AWS::IAM::Role" ||
    role.ResourceStatus !== "CREATE_COMPLETE" ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(role.PhysicalResourceId ?? "")
  )
    throw new Error("Participant role does not belong to the original stack");
  const roleArn = `arn:aws:iam::${input.target.accountId}:role/${role.PhysicalResourceId}`;
  const matching = (key: string, expected: string) => {
    const outputs = (stack.Outputs ?? []).filter((entry) => entry.OutputKey === key);
    return outputs.length === 1 && outputs[0]?.OutputValue === expected;
  };
  if (
    roleArn === input.target.roleArn ||
    !matching("ParticipantViewerRoleArn", roleArn) ||
    !matching("ParameterName", `/${name}/hello`)
  )
    throw new Error("Participant access output does not match the owned resource");
  return Object.freeze({
    roleArn,
    parameterArn: `arn:aws:ssm:${input.target.region}:${input.target.accountId}:parameter/${name}/hello`,
  });
}

function boundDeletionReference(
  input: CloudDeploymentInput,
  reference: DeploymentReference,
): DeploymentReference {
  const stackId = assertStackId(input, reference.stackId);
  const fingerprint = deploymentIdentity(input).fingerprint;
  if (reference.fingerprint !== fingerprint) {
    throw new Error("Deployment reference does not match the immutable input");
  }
  return Object.freeze({ stackId, fingerprint });
}

function deletionObservation(
  reference: DeploymentReference | undefined,
  phase: DeletionObservation["phase"],
  stackStatus: string,
): DeletionObservation {
  return Object.freeze({ ...(reference ? { reference } : {}), phase, stackStatus });
}

const deletableStatuses = new Set([
  "CREATE_COMPLETE",
  "CREATE_FAILED",
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "DELETE_FAILED",
]);

async function lookupOwnedDeletionStack(
  input: CloudDeploymentInput,
  reference: DeploymentReference | undefined,
  cfn: CloudFormationTransport,
  allowAbsent: boolean,
) {
  const stack = await lookupStack(cfn, reference?.stackId ?? deploymentIdentity(input).stackName);
  if (!stack) {
    // A lost CreateStack response is not evidence that no stack was created. Without a
    // recorded ARN the caller must prove, durably, that remote creation was never started.
    if (!allowAbsent) {
      throw new Error("CloudFormation stack absence is not confirmed for this teardown");
    }
    return { phase: "absent" as const, reference };
  }
  const stackId = assertOwnership(input, stack);
  if (reference && stackId !== reference.stackId) {
    throw new Error("CloudFormation replaced the deployment stack");
  }
  return {
    phase: "present" as const,
    reference:
      reference ?? Object.freeze({ stackId, fingerprint: deploymentIdentity(input).fingerprint }),
    stack,
  };
}

/** Delete only the exact owned create attempt. Creation in progress must converge first. */
export async function deleteDeployment(
  value: unknown,
  reference: DeploymentReference | undefined,
  deps: CloudRunnerDependencies,
  requestToken: string,
  allowAbsent: boolean,
  onResolved?: (reference: DeploymentReference) => Promise<void>,
): Promise<DeletionObservation> {
  const input = parseDeploymentInput(value);
  const boundReference = reference ? boundDeletionReference(input, reference) : undefined;
  if (typeof requestToken !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(requestToken)) {
    throw new Error("A bounded teardown request token is required");
  }
  if (typeof allowAbsent !== "boolean")
    throw new Error("Explicit stack absence permission is required");
  const cfn = await connect(input, deps);
  const owned = await lookupOwnedDeletionStack(input, boundReference, cfn, allowAbsent);
  if (owned.phase === "absent")
    return deletionObservation(owned.reference, "deleted", "DELETE_COMPLETE");
  // Persist a newly discovered physical ARN before a destructive request can lose its response.
  // A failed durability acknowledgement must leave the remote stack untouched.
  await onResolved?.(owned.reference);
  const status = owned.stack.StackStatus;
  if (status && pendingStatuses.has(status)) {
    return deletionObservation(owned.reference, "waiting", status);
  }
  if (status === "DELETE_IN_PROGRESS")
    return deletionObservation(owned.reference, "pending", status);
  if (status === "DELETE_COMPLETE") return deletionObservation(owned.reference, "deleted", status);
  if (!status || !deletableStatuses.has(status)) {
    throw new Error("Unexpected status for an owned CloudFormation teardown");
  }
  // Retries of one teardown keep the same bounded token; a new teardown after DELETE_FAILED
  // supplies a new token. Bind it to both the original request and resolved physical stack.
  const token = createHash("sha256")
    .update(JSON.stringify([owned.reference.fingerprint, owned.reference.stackId, requestToken]))
    .digest("hex");
  await cfn.deleteStack({
    StackName: owned.reference.stackId,
    ClientRequestToken: `tc-delete-${token}`,
  });
  return deletionObservation(owned.reference, "pending", "DELETE_IN_PROGRESS");
}

/** One safe teardown poll. Failure is visible; retries require a new explicit delete request. */
export async function describeDeletion(
  value: unknown,
  reference: DeploymentReference,
  deps: CloudRunnerDependencies,
  allowAbsent: boolean,
): Promise<DeletionObservation> {
  const input = parseDeploymentInput(value);
  const boundReference = boundDeletionReference(input, reference);
  if (typeof allowAbsent !== "boolean")
    throw new Error("Explicit stack absence permission is required");
  const cfn = await connect(input, deps);
  const owned = await lookupOwnedDeletionStack(input, boundReference, cfn, allowAbsent);
  if (owned.phase === "absent")
    return deletionObservation(owned.reference, "deleted", "DELETE_COMPLETE");
  const status = owned.stack.StackStatus;
  if (status === "DELETE_COMPLETE") return deletionObservation(owned.reference, "deleted", status);
  if (status === "DELETE_FAILED") return deletionObservation(owned.reference, "failed", status);
  if (status && pendingStatuses.has(status)) {
    return deletionObservation(owned.reference, "waiting", status);
  }
  // DescribeStacks can briefly retain the pre-delete terminal create status after acceptance.
  if (status && (status === "DELETE_IN_PROGRESS" || deletableStatuses.has(status))) {
    return deletionObservation(owned.reference, "pending", status);
  }
  throw new Error("Unexpected status for an owned CloudFormation teardown");
}

/** Bounded polling convenience for workers; durable orchestration can use describeDeployment. */
export async function pollDeployment(
  value: unknown,
  reference: DeploymentReference,
  deps: CloudRunnerDependencies,
  options: {
    readonly maxPolls: number;
    readonly intervalMs: number;
    readonly wait: (milliseconds: number) => Promise<void>;
  },
): Promise<DeploymentObservation> {
  const input = parseDeploymentInput(value);
  const boundReference = Object.freeze({ ...reference });
  const { maxPolls, intervalMs, wait } = options;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) {
    throw new Error("maxPolls must be between 1 and 120");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 30_000) {
    throw new Error("intervalMs must be between 1000 and 30000");
  }
  let result = await describeDeployment(input, boundReference, deps);
  for (let attempt = 1; result.phase === "pending" && attempt < maxPolls; attempt += 1) {
    await wait(intervalMs);
    result = await describeDeployment(input, boundReference, deps);
  }
  // Exhaustion is still pending, never fabricated success or a terminal failure.
  return result;
}
