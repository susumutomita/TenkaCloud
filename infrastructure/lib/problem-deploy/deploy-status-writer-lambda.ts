import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";

export interface DeployStatusWriterLambdaProps {
  readonly deploymentsTable: Table;
  readonly controlDataBackend?: string;
  readonly tursoDatabaseUrl?: string;
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Thin SFN status writer used only when DeployCreate's control-data backend is
 * pure SQL (`turso` / `sql`). The default and mirror backends keep the existing
 * native DynamoUpdateItem state machine path.
 */
export class DeployStatusWriterLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DeployStatusWriterLambdaProps) {
    super(scope, id);

    const backend = props.controlDataBackend ?? "dynamodb";
    const pureSql = backend === "turso" || backend === "sql";

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/deploy-status-writer-handler/index.ts"),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        ...controlDataBackendEnv(backend),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    if (!pureSql) {
      props.deploymentsTable.grantReadWriteData(this.fn);
    }
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${
              Stack.of(this).account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }
  }
}
