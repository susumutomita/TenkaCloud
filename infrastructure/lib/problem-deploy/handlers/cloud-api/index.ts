import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { DynamoCloudRepository } from "../../control-data/dynamodb-cloud-repository.js";
import { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { createCloudApp } from "./app.js";
import {
  createConnectionVerifier,
  createExecutionCatalogProvider,
  loadExecutionBindings,
} from "./execution-config.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud setting: ${name}`);
  return value;
}
const document = DynamoDBDocumentClient.from(
  new DynamoDBClient({ ignoreConfiguredEndpointUrls: true }),
  {
    marshallOptions: { removeUndefinedValues: true },
  },
);
const tables = {
  events: required("EVENTS_TABLE_NAME"),
  teams: required("TEAMS_TABLE_NAME"),
  deployments: required("DEPLOYMENTS_TABLE_NAME"),
};
const repository = new DynamoCloudRepository(document, tables);
async function compose() {
  const execution = process.env.CLOUD_RUNNER_BINDINGS_KEY
    ? {
        deployment: {
          work: new DynamoDeploymentWork(document, tables),
          catalog: createExecutionCatalogProvider(),
          controlPlaneAccount: required("CONTROL_PLANE_ACCOUNT"),
        },
        connections: {
          bindings: await loadExecutionBindings(),
          verify: createConnectionVerifier(),
        },
      }
    : {};
  return createCloudApp({
    repository,
    ...execution,
    organizerAuth: { issuer: required("COGNITO_ISSUER"), audience: required("COGNITO_CLIENT_ID") },
    allowedOrigins: required("ALLOWED_ORIGINS").split(","),
  });
}
let application: ReturnType<typeof compose> | undefined;
export async function handler(event: LambdaEvent, context: LambdaContext) {
  application ??= compose().catch((error: unknown) => {
    application = undefined;
    throw error;
  });
  return handle(await application)(event, context);
}
