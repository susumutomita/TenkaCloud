import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { loadExecutionBindings } from "../cloud-api/execution-config.js";
import { createAwsCloudRunnerDependencies } from "./sdk.js";
import {
  type ArtifactResolver,
  CloudWorkflowError,
  createWorkflowHandlers,
  type WorkflowState,
} from "./workflow.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new CloudWorkflowError();
  return value;
}

export async function createProductionWorkflowHandlers(resolveArtifacts: ArtifactResolver) {
  const region = required("AWS_REGION");
  assertCommercialRegion(region);
  const bindings = await loadExecutionBindings();
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, ignoreConfiguredEndpointUrls: true }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return createWorkflowHandlers({
    repository: new DynamoDeploymentWork(client, {
      events: required("EVENTS_TABLE_NAME"),
      teams: required("TEAMS_TABLE_NAME"),
      deployments: required("DEPLOYMENTS_TABLE_NAME"),
    }),
    runner: createAwsCloudRunnerDependencies({ controlPlaneRegion: region }),
    resolveArtifacts,
    authorizeJob: async (job) => {
      if (
        !bindings.some(
          (binding) =>
            binding.id === job.connection.bindingId &&
            binding.accountId === job.awsAccountId &&
            binding.region === job.region &&
            binding.roleArn === job.connection.roleArn &&
            binding.externalIdParameterArn === job.connection.externalIdParameter &&
            binding.reviewedProblemIds.includes(job.problemId) &&
            job.connection.reviewedProblemIds?.includes(job.problemId),
        )
      )
        throw new CloudWorkflowError();
    },
  });
}

async function invoke(
  action: keyof ReturnType<typeof createWorkflowHandlers>,
  value: unknown,
): Promise<WorkflowState> {
  try {
    const { createExecutionArtifactResolver } = await import("../cloud-api/execution-config.js");
    const handlers = await createProductionWorkflowHandlers(createExecutionArtifactResolver());
    return await handlers[action](value);
  } catch {
    throw new CloudWorkflowError();
  }
}
export const claimHandler = (value: unknown) => invoke("claim", value);
export const createHandler = (value: unknown) => invoke("create", value);
export const describeHandler = (value: unknown) => invoke("describe", value);
export const finishHandler = (value: unknown) => invoke("finish", value);
export const failHandler = (value: unknown) => invoke("fail", value);
