import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface ParticipantPortalLambdaProps {
  readonly deploymentsTable: ITable;
}

/**
 * Participant Portal backend Lambda。Function URL (AuthType=NONE) で公開し、
 * `Authorization: Bearer <teamLoginKey>` を Lambda 内で検証する。
 *
 * IAM は最小限: Deployments テーブルと GSI2 への Query 権限のみ。Worker / API
 * Lambda が持つ CFn AssumeRole / EventBridge / DDB 書き込み権限は付与しない。
 */
export class ParticipantPortalLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: ParticipantPortalLambdaProps) {
    super(scope, id);

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        DeploymentsRead: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                props.deploymentsTable.tableArn,
                `${props.deploymentsTable.tableArn}/index/GSI2`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/participant-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      role,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.GET],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
