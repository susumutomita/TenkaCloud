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
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface CoordinationTickLambdaProps {
  readonly deploymentsTable: ITable;
  readonly teamsTable: ITable;
  readonly pluginBucket: IBucket;
  readonly problemsCoordination: Readonly<Record<string, unknown>>;
}

/** Executes reviewed coordination reducers without inheriting GenericScoring's broad IAM. */
export class CoordinationTickLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: CoordinationTickLambdaProps) {
    super(scope, id);

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        CoordinationTick: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [props.deploymentsTable.tableArn],
            }),
            new PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [props.teamsTable.tableArn],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/coordination-tick-handler/index.ts"),
      timeout: Duration.seconds(30),
      memorySize: 512,
      role,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        COORDINATION_PLUGIN_BUCKET: props.pluginBucket.bucketName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundlingDefine: {
        "process.env.PROBLEM_COORDINATION": JSON.stringify(
          JSON.stringify(props.problemsCoordination),
        ),
      },
    });
    props.pluginBucket.grantRead(this.fn);
  }
}
