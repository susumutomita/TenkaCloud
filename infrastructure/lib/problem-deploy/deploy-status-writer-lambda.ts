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
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
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
 * pure SQL (`turso`). The default (dynamodb) backend keeps the existing
 * native DynamoUpdateItem state machine path.
 */
export class DeployStatusWriterLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DeployStatusWriterLambdaProps) {
    super(scope, id);

    const backend = props.controlDataBackend ?? "dynamodb";
    const pureSql = backend === "turso";

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/deploy-status-writer-handler/index.ts"),
      timeout: Duration.seconds(15),
      // Issue #2655: 1024MB でも live 実測で Runtime.OutOfMemory (Max Memory Used 1023MB)、
      // 2048MB では Max Memory Used 1259MB で init と handler validation が完了した。
      // #2864 で runtime bundle の根本修正 (`@aws-sdk/*` external 化、 1,131,725 → 283,647 bytes)
      // が入ったが、 memory を下げてよい根拠は live 再測定 (#2650) でしか得られないため、
      // 再測定が終わるまでは live-verified safety value 2048 を据え置く (= 推測で下げない)。
      memorySize: 2048,
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
