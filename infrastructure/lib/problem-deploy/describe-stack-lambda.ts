import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface DescribeStackLambdaProps {
  readonly environmentName: string;
}

/**
 * DeployCreate State Machine が CodeBuild 完了後に CFn StackId / Outputs を読むための
 * Lambda。CloudFormation `DescribeStacks` は competitor account 側で実行する必要がある
 * ため、verified deployment では ExternalId 付き AssumeRole を行う。
 */
export class DescribeStackLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DescribeStackLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/describe-stack-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // Issue #857 justify: CloudFormation:DescribeStacks は AWS API 制約上 Resource: "*" 必須
    // (= stack 名は動的、 ARN を synth 時に knowable でない)。 read-only 操作で blast radius 限定的。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DescribeStacks"],
        resources: ["*"],
      }),
    );

    const stack = Stack.of(this);
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [ssmArn],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn },
        },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );
  }
}
