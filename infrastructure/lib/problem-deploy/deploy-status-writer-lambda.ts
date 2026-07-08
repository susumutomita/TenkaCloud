import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";

export interface DeployStatusWriterLambdaProps {
  /**
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`/`sql`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。この Lambda は
   * `pureSql` のときのみ生成されるため、実運用では常に `undefined` で渡ってくる
   * (repository seam が SQL executor 直結で処理するため table 自体を参照しない)。
   */
  readonly deploymentsTable?: Table;
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
        // This Lambda is only synthesized when pureSql (see build-deploy-pipeline.ts), so in
        // production `deploymentsTable` is always undefined here — the repository seam never
        // touches DDB. Kept optional for defensive/test-level construction symmetry with the
        // other Deployments-consuming Lambdas.
        ...(props.deploymentsTable
          ? { DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName }
          : {}),
        ...controlDataBackendEnv(backend),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    if (!pureSql) {
      props.deploymentsTable?.grantReadWriteData(this.fn);
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
