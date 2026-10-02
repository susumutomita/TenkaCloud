import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { z } from "zod";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import type { CloudDeploymentWork } from "../../control-data/cloud-data-ports.js";
import { acquireCloudWork } from "../../control-data/cloud-work-data.js";
import {
  DeploymentConflict,
  type DeploymentIdentity,
} from "../../control-data/domain/deployment-work.js";
import { identitySchema, serializeDispatchIdentity } from "./workflow.js";

export interface DispatchDependencies {
  readonly repository: Pick<
    CloudDeploymentWork,
    "listDispatch" | "acceptingNewDeployments" | "getDeletionJob" | "getTeardown" | "finishTeardown"
  >;
  readonly describeExecution: RecoveryDependencies["describeExecution"];
  readonly now?: () => number;
  readonly stateMachineArn: string;
  readonly startExecution: (input: {
    readonly stateMachineArn: string;
    readonly name: string;
    readonly input: string;
  }) => Promise<{ readonly executionArn?: string }>;
}

export interface RecoveryDependencies {
  readonly repository: Pick<
    CloudDeploymentWork,
    "getJob" | "finish" | "failPending" | "getTeardown" | "finishTeardown"
  >;
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
async function verifiedTerminalExecution(
  value: unknown,
  deps: Pick<RecoveryDependencies, "stateMachineArn" | "describeExecution">,
) {
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

async function recoverTeardownExecution(
  execution: NonNullable<Awaited<ReturnType<typeof verifiedTerminalExecution>>>,
  deps: {
    readonly repository: Pick<CloudDeploymentWork, "getTeardown" | "finishTeardown">;
    readonly now?: () => number;
  },
) {
  const { identity } = execution;
  let marker: Awaited<ReturnType<RecoveryDependencies["repository"]["getTeardown"]>>;
  try {
    marker = await deps.repository.getTeardown(identity);
  } catch (error) {
    if (error instanceof DeploymentConflict) return { outcome: "stale" };
    throw error;
  }
  if (!marker) return { outcome: "stale" };
  if (marker.status === "DELETED" || marker.status === "FAILED")
    return { outcome: "already_terminal" };
  if (
    marker.eventId !== identity.eventId ||
    marker.teamId !== identity.teamId ||
    marker.jobId !== identity.jobId ||
    marker.attempt !== identity.attempt ||
    marker.generation !== identity.generation ||
    (marker.status === "PENDING"
      ? marker.owner !== undefined
      : marker.owner !== execution.executionArn)
  )
    return { outcome: "stale" };
  await deps.repository.finishTeardown(
    identity,
    marker.owner,
    {
      status: "FAILED",
      failureReason: `workflow_${execution.status.toLowerCase()}`,
      ...(marker.stackId ? { stackId: marker.stackId } : {}),
    },
    new Date((deps.now ?? Date.now)()).toISOString(),
  );
  return { outcome: marker.owner ? "failed_owned" : "failed_pending" };
}

export async function recoverTerminalExecution(value: unknown, deps: RecoveryDependencies) {
  const execution = await verifiedTerminalExecution(value, deps);
  if (!execution) return { outcome: "ignored" };
  const { identity } = execution;
  if (identity.operation === "delete") return recoverTeardownExecution(execution, deps);
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
  return identity.operation === "delete"
    ? `tc-delete-${identity.jobId}-${identity.attempt}-${identity.generation}`
    : `tc-${identity.jobId}-${identity.attempt}`;
}

/** A c091 worker/recovery can reject historical work without leaving a retryable failure.
 * Reconcile only a verified negative terminal execution; never take over running work. */
async function reconcileHistoricalDuplicate(
  deps: DispatchDependencies,
  identity: DeploymentIdentity,
) {
  if (identity.operation !== "delete") return;
  const source = await deps.repository.getDeletionJob(identity);
  if (!source.historical) return;
  const executionArn = `${deps.stateMachineArn.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(identity)}`;
  const execution = await verifiedTerminalExecution(
    {
      source: "aws.states",
      "detail-type": "Step Functions Execution Status Change",
      detail: { stateMachineArn: deps.stateMachineArn, executionArn, status: "FAILED" },
    },
    deps,
  );
  if (!execution) return;
  if (serializeDispatchIdentity(execution.identity) !== serializeDispatchIdentity(identity))
    throw new Error("Duplicate execution input does not match its dispatch intent");
  await recoverTeardownExecution(execution, deps);
}

async function dispatchOne(
  deps: DispatchDependencies,
  value: DeploymentIdentity,
): Promise<"started" | "duplicate" | "uncertain"> {
  let identity: DeploymentIdentity | undefined;
  try {
    identity = identitySchema.parse({
      eventId: value.eventId,
      teamId: value.teamId,
      jobId: value.jobId,
      attempt: value.attempt,
      ...(value.operation ? { operation: value.operation, generation: value.generation } : {}),
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
    if (!(error instanceof Error) || error.name !== "ExecutionAlreadyExists" || !identity)
      return "uncertain";
    try {
      await reconcileHistoricalDuplicate(deps, identity);
      return "duplicate";
    } catch {
      return "uncertain";
    }
  }
}

/** Claims remove accepted intents. Historical duplicates may reconcile an already-terminal execution. */
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
  const deletesOnly = !(await deps.repository.acceptingNewDeployments());
  const intents = await deps.repository.listDispatch(limit, { deletesOnly });
  if (intents.length > limit) throw new Error("Dispatcher repository exceeded the requested limit");
  if (deletesOnly && intents.some((intent) => intent.operation !== "delete"))
    throw new Error("Creation dispatch is closed for this installation");
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

export async function createAwsDispatcherDependencies(): Promise<DispatchDependencies> {
  const region = required("AWS_REGION");
  assertCommercialRegion(region);
  const client = new SFNClient({ region, ignoreConfiguredEndpointUrls: true });
  const { work } = await acquireCloudWork();
  return {
    repository: work,
    stateMachineArn: required("DEPLOYMENT_STATE_MACHINE_ARN"),
    startExecution: (input) => client.send(new StartExecutionCommand(input)),
    describeExecution: (input) => client.send(new DescribeExecutionCommand(input)),
  };
}

export async function handler(): Promise<Awaited<ReturnType<typeof dispatchPending>>> {
  try {
    const result = await dispatchPending(await createAwsDispatcherDependencies(), {
      limit: 500,
      concurrency: 5,
    });
    if (result.uncertain > 0) throw new Error("One or more execution submissions were uncertain");
    return result;
  } catch {
    throw new Error("Cloud dispatch failed; pending intents were retained");
  }
}

export async function createAwsRecoveryDependencies(): Promise<RecoveryDependencies> {
  const region = required("AWS_REGION");
  assertCommercialRegion(region);
  const client = new SFNClient({ region, ignoreConfiguredEndpointUrls: true });
  const { work } = await acquireCloudWork();
  return {
    repository: work,
    stateMachineArn: required("DEPLOYMENT_STATE_MACHINE_ARN"),
    describeExecution: (input) => client.send(new DescribeExecutionCommand(input)),
  };
}
export async function recoveryHandler(value: unknown) {
  try {
    return await recoverTerminalExecution(value, await createAwsRecoveryDependencies());
  } catch {
    throw new Error("Cloud terminal-execution reconciliation failed");
  }
}
