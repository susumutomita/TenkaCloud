import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { DeploymentMutationOutcome, DeploymentsRepository } from "../../control-data/types.js";

export type DeployStatusWriterTransition =
  | "markInProgress"
  | "markSucceeded"
  | "markFailed"
  | "markDeleted";

export interface DeployStatusWriterEvent {
  readonly transition?: DeployStatusWriterTransition;
  readonly jobId?: string;
  readonly updatedAt?: string;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly buildId?: string;
}

export interface DeployStatusWriterResources {
  readonly ddb: DynamoDBDocumentClient;
  readonly deploymentsTableName: string;
}

export interface DeployStatusWriterDeps {
  readonly repository: DeploymentsRepository;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`DeployStatusWriter event field "${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`DeployStatusWriter event field "${field}" must be a non-empty string.`);
  }
  return value;
}

function assertUpdated(outcome: DeploymentMutationOutcome, jobId: string): void {
  if (outcome.outcome !== "updated") {
    throw new Error(`DeployStatusWriter failed to update deployment ${jobId}: ${outcome.outcome}`);
  }
}

export async function applyDeployStatusWrite(
  event: DeployStatusWriterEvent,
  deps: DeployStatusWriterDeps,
): Promise<DeploymentMutationOutcome> {
  const transition = requireString(event.transition, "transition") as DeployStatusWriterTransition;
  const jobId = requireString(event.jobId, "jobId");
  const updatedAt = requireString(event.updatedAt, "updatedAt");

  switch (transition) {
    case "markInProgress":
      return deps.repository.markCreateInProgress(jobId, updatedAt);
    case "markSucceeded":
      return deps.repository.markCreateSucceeded(
        jobId,
        requireString(event.stackId, "stackId"),
        requireString(event.stackOutputs, "stackOutputs"),
        optionalString(event.buildId, "buildId"),
        updatedAt,
      );
    case "markFailed":
      // Shared by both DeployCreate's MarkFailed/MarkFailedWithoutBuildId and
      // DeployDelete's MarkFailed (#2441 Phase B PR-6): the DDB UpdateExpression is
      // byte-identical (SET status=FAILED, updatedAt, failureReason, optional
      // buildId) regardless of which state machine wrote it — DeployDelete never
      // sends `buildId`, matching the CodeBuild-only `buildId` semantics already
      // encoded by {@link optionalString}.
      return deps.repository.markCreateFailed(
        jobId,
        requireString(event.failureReason, "failureReason"),
        optionalString(event.buildId, "buildId"),
        updatedAt,
      );
    case "markDeleted":
      return deps.repository.markDeleted(jobId, updatedAt);
    default:
      throw new Error(`Unsupported DeployStatusWriter transition: ${transition}`);
  }
}

export function buildDeployStatusWriterResources(): DeployStatusWriterResources {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
  };
}

export function resolveDeploymentsRepository(
  resources: DeployStatusWriterResources,
): Promise<DeploymentsRepository> {
  return controlDataRuntime.resolveDeploymentsRepository({
    ddb: resources.ddb,
    deploymentsTableName: resources.deploymentsTableName,
  });
}

const shared = buildDeployStatusWriterResources();

export async function handler(event: DeployStatusWriterEvent): Promise<DeploymentMutationOutcome> {
  const repository = await resolveDeploymentsRepository(shared);
  const outcome = await applyDeployStatusWrite(event, { repository });
  assertUpdated(outcome, requireString(event.jobId, "jobId"));
  return outcome;
}
