import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import type { DeploymentIdentity } from "../../control-data/domain/deployment-work.js";
import { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { identitySchema, serializeDispatchIdentity } from "./workflow.js";

export interface DispatchDependencies {
  readonly repository: Pick<DynamoDeploymentWork, "listDispatch">;
  readonly stateMachineArn: string;
  readonly startExecution: (input: {
    readonly stateMachineArn: string;
    readonly name: string;
    readonly input: string;
  }) => Promise<{ readonly executionArn?: string }>;
}

export interface RecoveryDependencies {
  readonly repository: Pick<DynamoDeploymentWork, "getJob" | "finish" | "failPending">;
  readonly stateMachineArn: string;
  readonly describeExecution: (input: { readonly executionArn: string }) => Promise<{
    readonly executionArn?: string;
    readonly stateMachineArn?: string;
    readonly status?: string;
    readonly input?: string;
  }>;
  readonly now?: () => number;
}
const terminalStatuses = new Set(["FAILED", "TIMED_OUT", "ABORTED"]);
const terminalEventSchema = z.object({
  source: z.literal("aws.states"),
  "detail-type": z.literal("Step Functions Execution Status Change"),
  detail: z.object({
    stateMachineArn: z.string().max(256),
    executionArn: z.string().max(256),
    status: z.enum(["FAILED", "TIMED_OUT", "ABORTED"]),
  }),
});

/** Verify the authoritative execution before fenced reconciliation; event payload is not authority. */
async function verifiedTerminalExecution(value: unknown, deps: RecoveryDependencies) {
  const event = terminalEventSchema.parse(value);
  const prefix = `${deps.stateMachineArn.replace(":stateMachine:", ":execution:")}:`;
  if (
    event.detail.stateMachineArn !== deps.stateMachineArn ||
    !event.detail.executionArn.startsWith(prefix)
  )
    throw new Error("Terminal execution target mismatch");
  const execution = await deps.describeExecution({ executionArn: event.detail.executionArn });
  if (
    execution.executionArn !== event.detail.executionArn ||
    execution.stateMachineArn !== deps.stateMachineArn
  )
    throw new Error("Execution description identity mismatch");
  if (!execution.status || !terminalStatuses.has(execution.status)) return undefined;
  if (!execution.input || Buffer.byteLength(execution.input, "utf8") > 4096)
    throw new Error("Invalid execution input");
  const identity = z
    .object({ identity: identitySchema })
    .strict()
    .parse(JSON.parse(execution.input) as unknown).identity;
  if (
    serializeDispatchIdentity(identity) !== execution.input ||
    `${prefix}${dispatchExecutionName(identity)}` !== execution.executionArn
  )
    throw new Error("Execution identity does not match canonical dispatch input");
  return { identity, executionArn: execution.executionArn, status: execution.status };
}

export async function recoverTerminalExecution(value: unknown, deps: RecoveryDependencies) {
  const execution = await verifiedTerminalExecution(value, deps);
  if (!execution) return { outcome: "ignored" };
  const { identity } = execution;
  const job = await deps.repository.getJob(identity.jobId);
  if (
    !job ||
    job.eventId !== identity.eventId ||
    job.teamId !== identity.teamId ||
    job.attempt !== identity.attempt
  )
    return { outcome: "stale" };
  if (job.status === "COMPLETE" || job.status === "FAILED") return { outcome: "already_terminal" };
  const reason = `workflow_${execution.status.toLowerCase()}`;
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  if (job.status === "PENDING" && !job.owner) {
    await deps.repository.failPending(identity, reason, at);
    return { outcome: "failed_pending" };
  }
  if (job.status !== "IN_PROGRESS" || job.owner !== execution.executionArn)
    return { outcome: "stale" };
  await deps.repository.finish(
    identity,
    execution.executionArn,
    { status: "FAILED", failureReason: reason, ...(job.stackId ? { stackId: job.stackId } : {}) },
    at,
  );
  return { outcome: "failed_owned" };
}

export function dispatchExecutionName(value: DeploymentIdentity): string {
  const identity = identitySchema.parse(value);
  return `tc-${identity.jobId}-${identity.attempt}`;
}

async function dispatchOne(
  deps: DispatchDependencies,
  value: DeploymentIdentity,
): Promise<"started" | "duplicate" | "uncertain"> {
  try {
    const identity = identitySchema.parse({
      eventId: value.eventId,
      teamId: value.teamId,
      jobId: value.jobId,
      attempt: value.attempt,
    });
    const name = dispatchExecutionName(identity);
    const result = await deps.startExecution({
      stateMachineArn: deps.stateMachineArn,
      name,
      input: serializeDispatchIdentity(identity),
    });
    const expected = `${deps.stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
    if (result.executionArn !== expected) throw new Error("Execution identity mismatch");
    return "started";
  } catch (error) {
    return error instanceof Error && error.name === "ExecutionAlreadyExists"
      ? "duplicate"
      : "uncertain";
  }
}

/** Start only. The claim transaction, never this dispatcher, removes an accepted intent. */
export async function dispatchPending(
  deps: DispatchDependencies,
  options: { readonly limit?: number; readonly concurrency?: number } = {},
) {
  const limit = options.limit ?? 100;
  const concurrency = options.concurrency ?? 5;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 10
  )
    throw new Error("Invalid dispatcher bounds");
  if (!/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]+$/u.test(deps.stateMachineArn))
    throw new Error("An explicit Standard state machine ARN is required");
  const intents = await deps.repository.listDispatch(limit);
  if (intents.length > limit) throw new Error("Dispatcher repository exceeded the requested limit");
  const summary = { pending: intents.length, started: 0, duplicate: 0, uncertain: 0 };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, intents.length) }, async () => {
      for (;;) {
        const intent = intents[cursor++];
        if (!intent) return;
        summary[await dispatchOne(deps, intent)] += 1;
      }
    }),
  );
  return Object.freeze(summary);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing cloud dispatcher configuration");
  return value;
}

export function createAwsDispatcherDependencies(): DispatchDependencies {
  const region = required("AWS_REGION");
  assertCommercialRegion(region);
  const client = new SFNClient({ region, ignoreConfiguredEndpointUrls: true });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, ignoreConfiguredEndpointUrls: true }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return {
    repository: new DynamoDeploymentWork(ddb, {
      events: required("EVENTS_TABLE_NAME"),
      teams: required("TEAMS_TABLE_NAME"),
      deployments: required("DEPLOYMENTS_TABLE_NAME"),
    }),
    stateMachineArn: required("DEPLOYMENT_STATE_MACHINE_ARN"),
    startExecution: (input) => client.send(new StartExecutionCommand(input)),
  };
}

export async function handler(): Promise<Awaited<ReturnType<typeof dispatchPending>>> {
  try {
    const result = await dispatchPending(createAwsDispatcherDependencies(), {
      limit: 500,
      concurrency: 5,
    });
    if (result.uncertain > 0) throw new Error("One or more execution submissions were uncertain");
    return result;
  } catch {
    throw new Error("Cloud dispatch failed; pending intents were retained");
  }
}

export function createAwsRecoveryDependencies(): RecoveryDependencies {
  const region = required("AWS_REGION");
  assertCommercialRegion(region);
  const client = new SFNClient({ region, ignoreConfiguredEndpointUrls: true });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, ignoreConfiguredEndpointUrls: true }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return {
    repository: new DynamoDeploymentWork(ddb, {
      events: required("EVENTS_TABLE_NAME"),
      teams: required("TEAMS_TABLE_NAME"),
      deployments: required("DEPLOYMENTS_TABLE_NAME"),
    }),
    stateMachineArn: required("DEPLOYMENT_STATE_MACHINE_ARN"),
    describeExecution: (input) => client.send(new DescribeExecutionCommand(input)),
  };
}
export async function recoveryHandler(value: unknown) {
  try {
    return await recoverTerminalExecution(value, createAwsRecoveryDependencies());
  } catch {
    throw new Error("Cloud terminal-execution reconciliation failed");
  }
}
