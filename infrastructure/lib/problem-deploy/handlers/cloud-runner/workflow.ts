import { z } from "zod";
import {
  type DeploymentConnection,
  type DeploymentIdentity,
  type DeploymentJob,
  flagDigest,
} from "../../control-data/domain/deployment-work.js";
import type {
  DeploymentCompletion,
  DynamoDeploymentWork,
} from "../../control-data/dynamodb-deployment-work.js";
import {
  type CloudRunnerDependencies,
  createDeployment,
  type DeploymentObservation,
  type DeploymentReference,
  deploymentIdentity,
  describeDeployment,
  parseDeploymentInput,
} from "./index.js";

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const identitySchema = z
  .object({
    eventId: id,
    teamId: id,
    jobId: id,
    attempt: z.number().int().positive().max(1_000_000),
  })
  .strict();
const stateSchema = z
  .object({
    identity: identitySchema,
    owner: z
      .string()
      .max(256)
      .regex(/^arn:aws:states:[a-z0-9-]+:\d{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u),
    phase: z.enum(["pending", "ready", "failed"]).default("pending"),
    pollCount: z.number().int().min(0).max(120).default(0),
    reference: z
      .object({ stackId: z.string().max(2048), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .optional(),
    failureCode: z
      .enum(["worker_failed", "poll_limit_exceeded", "stack_failed", "flag_output_missing"])
      .optional(),
  })
  .strict();
export type WorkflowState = z.infer<typeof stateSchema>;
export interface DeploymentArtifacts {
  readonly templateBody: string;
  readonly artifactDigest: string;
  readonly capabilities: readonly ("CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM")[];
  readonly publicOutputKeys: readonly string[];
}
export type ArtifactResolver = (job: DeploymentJob) => Promise<DeploymentArtifacts>;
export type WorkflowRepository = Pick<
  DynamoDeploymentWork,
  "getJob" | "getConnection" | "begin" | "finish"
>;
export interface WorkflowDependencies {
  readonly repository: WorkflowRepository;
  readonly runner: CloudRunnerDependencies;
  readonly resolveArtifacts: ArtifactResolver;
  readonly authorizeJob: (job: DeploymentJob) => Promise<void>;
  readonly now?: () => number;
}

/** A fixed, non-secret error crosses the Lambda/SFN boundary; SDK messages never do. */
export class CloudWorkflowError extends Error {
  constructor() {
    super("Cloud deployment worker could not complete its operation");
    this.name = "CloudWorkflowError";
  }
}

function sameConnection(a: DeploymentConnection, b: DeploymentConnection): boolean {
  return (
    a.eventId === b.eventId &&
    a.teamId === b.teamId &&
    a.version === b.version &&
    a.accountId === b.accountId &&
    a.region === b.region &&
    a.roleArn === b.roleArn &&
    a.externalIdParameter === b.externalIdParameter &&
    a.verifiedAt === b.verifiedAt &&
    a.bindingId === b.bindingId &&
    JSON.stringify(a.reviewedProblemIds) === JSON.stringify(b.reviewedProblemIds)
  );
}

async function ownedJob(state: WorkflowState, deps: WorkflowDependencies, claimed = true) {
  const job = await deps.repository.getJob(state.identity.jobId);
  if (
    !job ||
    job.eventId !== state.identity.eventId ||
    job.teamId !== state.identity.teamId ||
    job.attempt !== state.identity.attempt ||
    (claimed && job.owner !== state.owner)
  ) {
    throw new CloudWorkflowError();
  }
  return job;
}

async function guardRemote(job: DeploymentJob, deps: WorkflowDependencies): Promise<void> {
  await deps.authorizeJob(job);
  const connection = await deps.repository.getConnection(job.eventId, job.teamId);
  if (
    !connection ||
    !sameConnection(job.connection, connection) ||
    job.connection.eventId !== job.eventId ||
    job.connection.teamId !== job.teamId ||
    job.awsAccountId !== job.connection.accountId ||
    job.region !== job.connection.region ||
    job.expiresAt <= Math.floor((deps.now ?? Date.now)() / 1000)
  )
    throw new CloudWorkflowError();
}

async function runnerInput(job: DeploymentJob, deps: WorkflowDependencies) {
  const artifact = await deps.resolveArtifacts(job);
  if (
    artifact.artifactDigest !== job.artifactDigest ||
    !job.parameters ||
    job.parameters.NamePrefix !== job.stackName ||
    artifact.publicOutputKeys.includes(job.scoring.flagOutputKey)
  ) {
    throw new CloudWorkflowError();
  }
  const input = parseDeploymentInput({
    version: 1,
    eventId: job.eventId,
    teamId: job.teamId,
    problemId: job.problemId,
    jobId: job.jobId,
    attemptId: String(job.attempt),
    target: {
      accountId: job.awsAccountId,
      region: job.region,
      roleArn: job.connection.roleArn,
      externalIdParameterArn: job.connection.externalIdParameter,
    },
    templateBody: artifact.templateBody,
    parameters: Object.entries(job.parameters).map(([key, value]) => ({ key, value })),
    capabilities: artifact.capabilities,
    allowedOutputKeys: [...artifact.publicOutputKeys, job.scoring.flagOutputKey],
  });
  if (deploymentIdentity(input).stackName !== job.stackName) throw new CloudWorkflowError();
  return { input, publicOutputKeys: Object.freeze([...artifact.publicOutputKeys]) };
}

function safeObservation(state: WorkflowState, result: DeploymentObservation): WorkflowState {
  return { ...state, phase: result.phase, reference: result.reference };
}

function completedState(state: WorkflowState, job: DeploymentJob): WorkflowState | undefined {
  if (job.status === "COMPLETE") return { ...state, phase: "ready" };
  if (job.status === "FAILED") return { ...state, phase: "failed" };
  return undefined;
}

/** Re-read immediately after artifact I/O, before any remote resource operation. */
async function prepareRemote(state: WorkflowState, deps: WorkflowDependencies) {
  const job = await ownedJob(state, deps);
  if (job.status !== "IN_PROGRESS") throw new CloudWorkflowError();
  await guardRemote(job, deps);
  const prepared = await runnerInput(job, deps);
  const latest = await ownedJob(state, deps);
  if (JSON.stringify(latest) !== JSON.stringify(job)) throw new CloudWorkflowError();
  await guardRemote(latest, deps);
  return { ...prepared, job };
}

function requireReference(state: WorkflowState): DeploymentReference {
  if (!state.reference) throw new CloudWorkflowError();
  return state.reference;
}

function selectPublicOutputs(
  keys: readonly string[],
  privateKey: string,
  outputs: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of keys) {
    const output = outputs[key];
    if (key !== privateKey && output !== undefined) selected[key] = output;
  }
  return selected;
}

export function createWorkflowHandlers(deps: WorkflowDependencies) {
  const at = () => new Date((deps.now ?? Date.now)()).toISOString();
  const wrap =
    (action: (state: WorkflowState) => Promise<WorkflowState>) =>
    async (value: unknown): Promise<WorkflowState> => {
      try {
        return stateSchema.parse(await action(stateSchema.parse(value)));
      } catch {
        throw new CloudWorkflowError();
      }
    };
  const claim = wrap(async (state) => {
    const job = await ownedJob(state, deps, false);
    if (job.owner === state.owner) {
      const done = completedState(state, job);
      if (done) return done;
    }
    if (job.status !== "PENDING" && !(job.status === "IN_PROGRESS" && job.owner === state.owner))
      throw new CloudWorkflowError();
    await guardRemote(job, deps);
    await deps.repository.begin(state.identity, state.owner, at());
    return { ...state, phase: "pending" };
  });
  const create = wrap(async (state) => {
    const job = await ownedJob(state, deps);
    const done = completedState(state, job);
    if (done) return done;
    const { input } = await prepareRemote(state, deps);
    return safeObservation(state, await createDeployment(input, deps.runner));
  });
  const describe = wrap(async (state) => {
    if (state.pollCount >= 120) throw new CloudWorkflowError();
    const job = await ownedJob(state, deps);
    const done = completedState(state, job);
    if (done) return done;
    const { input } = await prepareRemote(state, deps);
    const result = await describeDeployment(input, requireReference(state), deps.runner);
    return safeObservation({ ...state, pollCount: state.pollCount + 1 }, result);
  });
  const fail = wrap(async (state) => {
    const job = await ownedJob(state, deps);
    const done = completedState(state, job);
    if (done) return done;
    if (job.status !== "IN_PROGRESS") throw new CloudWorkflowError();
    await deps.repository.finish(
      state.identity,
      state.owner,
      {
        status: "FAILED",
        failureReason: state.failureCode ?? "worker_failed",
        ...(state.reference ? { stackId: state.reference.stackId } : {}),
      },
      at(),
    );
    return { ...state, phase: "failed" };
  });
  const finish = wrap(async (state) => {
    const job = await ownedJob(state, deps);
    const done = completedState(state, job);
    if (done) return done;
    if (state.phase === "failed") return fail({ ...state, failureCode: "stack_failed" });
    if (state.phase !== "ready") throw new CloudWorkflowError();
    const { input, publicOutputKeys } = await prepareRemote(state, deps);
    const result = await describeDeployment(input, requireReference(state), deps.runner);
    if (result.phase !== "ready") throw new CloudWorkflowError();
    const flag = result.outputs[job.scoring.flagOutputKey];
    if (!flag?.trim()) return fail({ ...state, failureCode: "flag_output_missing" });
    const publicOutputs = selectPublicOutputs(
      publicOutputKeys,
      job.scoring.flagOutputKey,
      result.outputs,
    );
    const completion: DeploymentCompletion = {
      status: "COMPLETE",
      stackId: result.reference.stackId,
      flagDigest: flagDigest(flag),
      publicOutputs,
    };
    await deps.repository.finish(state.identity, state.owner, completion, at());
    return { ...state, phase: "ready" };
  });
  return { claim, create, describe, finish, fail };
}

/** Stable canonical identity bytes are also the Standard SFN idempotency input. */
export function serializeDispatchIdentity(value: DeploymentIdentity): string {
  return JSON.stringify({ identity: identitySchema.parse(value) });
}
