import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { DynamoCloudRepository } from "../../control-data/dynamodb-cloud-repository.js";
import { createCloudApp } from "./app.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud setting: ${name}`);
  return value;
}
const repository = new DynamoCloudRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  {
    events: required("EVENTS_TABLE_NAME"),
    teams: required("TEAMS_TABLE_NAME"),
    deployments: required("DEPLOYMENTS_TABLE_NAME"),
  },
);
export const handler = handle(
  createCloudApp({
    repository,
    organizerAuth: { issuer: required("COGNITO_ISSUER"), audience: required("COGNITO_CLIENT_ID") },
    allowedOrigins: required("ALLOWED_ORIGINS").split(","),
  }),
);
