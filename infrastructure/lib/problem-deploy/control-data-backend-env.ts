import { Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { CloudControlDataConfiguration } from "../cloud-hosting/config.js";

export type CloudControlDataResources =
  | {
      readonly kind: "dynamodb";
      readonly events: ITable;
      readonly teams: ITable;
      readonly deployments: ITable;
    }
  | Extract<CloudControlDataConfiguration, { readonly kind: "turso" }>;

/** Keep the original shared environment/SSM wiring; DynamoDB remains the default. */
export function controlDataRuntimeEnv(data: CloudControlDataResources): Record<string, string> {
  if (data.kind === "dynamodb")
    return {
      EVENTS_TABLE_NAME: data.events.tableName,
      TEAMS_TABLE_NAME: data.teams.tableName,
      DEPLOYMENTS_TABLE_NAME: data.deployments.tableName,
    };
  return {
    CONTROL_DATA_BACKEND: "turso",
    TURSO_DATABASE_URL: data.databaseUrl,
    TURSO_AUTH_TOKEN_PARAMETER_NAME: data.authTokenParameterName,
  };
}

/** Original exact-parameter SecureString grant; tokens use the AWS managed SSM key. */
export function grantTursoAuthTokenRead(fn: IFunction, data: CloudControlDataResources): void {
  if (data.kind !== "turso") return;
  const stack = Stack.of(fn);
  const parameterArn = `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${data.authTokenParameterName}`;
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
  );
}
