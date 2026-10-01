import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import { DynamoDbCompetitorAccountsRepository } from "../../control-data/dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import {
  createJobBindingAuthorizer,
  installationAccountConfig,
  loadExecutionBindings,
} from "../cloud-api/execution-config.js";
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
  const controlPlaneAccount = required("CONTROL_PLANE_ACCOUNT");
  if (!/^\d{12}$/u.test(controlPlaneAccount)) throw new CloudWorkflowError();
  assertCommercialRegion(region);
  const bindings = await loadExecutionBindings();
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, ignoreConfiguredEndpointUrls: true }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const tables = {
    events: required("EVENTS_TABLE_NAME"),
    teams: required("TEAMS_TABLE_NAME"),
    deployments: required("DEPLOYMENTS_TABLE_NAME"),
  };
  const accounts = new DynamoDbCompetitorAccountsRepository(client, tables);
  const config = process.env.COMPETITOR_ROLE_NAME ? installationAccountConfig() : undefined;
  return createWorkflowHandlers({
    repository: new DynamoDeploymentWork(client, tables),
    runner: createAwsCloudRunnerDependencies({ controlPlaneRegion: region }),
    resolveArtifacts,
    authorizeJob: createJobBindingAuthorizer({ bindings, accounts, config, controlPlaneAccount }),
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
