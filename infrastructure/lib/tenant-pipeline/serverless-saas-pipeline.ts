// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import type { Construct } from "constructs";

const DEPLOYMENT_STATE_MACHINE_NAME_SUFFIX = "saas-deployment-machine";
const TENANT_UPDATE_SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../../../scripts/update-tenant.sh",
);
const TENANT_PIPELINE_LAMBDA_RUNTIME = lambda.Runtime.PYTHON_3_14;
const TENANT_PIPELINE_CODEBUILD_IMAGE_ID = "aws/codebuild/standard:8.0";
const TENANT_PIPELINE_CODEBUILD_NODE_VERSION = 24;

const sanitizeNamePart = (value: string, fallback: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || fallback;
};

const buildDeploymentStateMachineName = (appName: string, environmentName: string): string => {
  const namespace = [
    sanitizeNamePart(appName, "tenkacloud"),
    sanitizeNamePart(environmentName, "development"),
  ].join("-");
  const maxNamespaceLength = 80 - DEPLOYMENT_STATE_MACHINE_NAME_SUFFIX.length - 1;
  const safeNamespace = namespace.slice(0, maxNamespaceLength).replace(/-$/g, "");
  return `${safeNamespace}-${DEPLOYMENT_STATE_MACHINE_NAME_SUFFIX}`;
};

export interface ServerlessSaaSPipelineInterface extends cdk.StackProps {
  appName: string;
  environmentName: string;
  tenantMappingTable: Table;
  s3SourceBucket: string;
  sourceZip: string;
}

export class ServerlessSaaSPipeline extends cdk.Stack {
  /** Tenant provisioning CodeBuild project name for CloudWatch metrics. */
  public readonly provisioningCodeBuildProjectName: string;

  constructor(scope: Construct, id: string, props: ServerlessSaaSPipelineInterface) {
    super(scope, id, props);
    const deploymentStateMachineName = buildDeploymentStateMachineName(
      props.appName,
      props.environmentName,
    );

    // Artifacts bucket.
    const artifactsBucket = new s3.Bucket(this, "ArtifactsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Lambda functions.
    const lambdaPolicy = new iam.PolicyStatement({
      actions: ["s3:*Object"],
      resources: [`${artifactsBucket.bucketArn}/*`],
    });
    // Lambda handler のソースは Construct と co-locate (handlers/)。旧 ref-arch では
    // リポジトリルート src/ にあったが #76 で整理した。
    const handlersPath = path.join(import.meta.dirname, "handlers");
    const lambdaFunctionPrep = new lambda.Function(this, "prep-deploy", {
      logGroup: new logs.LogGroup(this, "PrepDeployLogGroup", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      handler: "lambda-prepare-deploy.lambda_handler",
      runtime: TENANT_PIPELINE_LAMBDA_RUNTIME,
      code: new lambda.AssetCode(handlersPath),
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      environment: {
        BUCKET: artifactsBucket.bucketName,
        TENANT_MAPPING_TABLE: props.tenantMappingTable.tableName,
      },
      initialPolicy: [lambdaPolicy],
    });

    lambdaFunctionPrep.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [artifactsBucket.bucketArn],
      }),
    );

    // Issue #857 justify: SBT vendored — このファイルは aws-samples/serverless-saas-* の
    // upstream pattern をそのまま導入したもの。 CodePipeline PutJob* / KMS Decrypt は API 制約上
    // Resource: "*" が必要。 upstream に追従するため scope 変更を保留。
    lambdaFunctionPrep.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "codepipeline:PutJobSuccessResult",
          "codepipeline:PutJobFailureResult",
          "kms:Decrypt",
        ],
        resources: ["*"],
      }),
    );

    lambdaFunctionPrep.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.tenantMappingTable.tableName}`,
        ],
      }),
    );

    lambdaFunctionPrep.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLambdaInsightsExecutionRolePolicy"),
    );
    lambdaFunctionPrep.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    );

    const sourceCodeBucket = s3.Bucket.fromBucketName(this, "S3SourceBucket", props.s3SourceBucket);

    // Define the CodeBuild project.
    const codeBuildProject = new codebuild.Project(this, "CdkCodeBuildProject", {
      source: codebuild.Source.s3({
        bucket: sourceCodeBucket,
        path: props.sourceZip,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromCodeBuildImageId(
          TENANT_PIPELINE_CODEBUILD_IMAGE_ID,
        ),
        privileged: true, // Required for Docker
        environmentVariables: {
          STACK_NAME: { value: "default-stack-name" },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": {
              nodejs: TENANT_PIPELINE_CODEBUILD_NODE_VERSION,
            },
            commands: ["npm install -g aws-cdk"],
          },
          build: {
            // #690: CodeBuild の default shell は dash (POSIX sh) で `set -o pipefail` を
            // サポートしない。 script に shebang `#!/bin/bash` を書いても commands embed では
            // 単なるコメント扱いで効かない。 `bash -ex <<'EOSCRIPT'` heredoc で明示的に bash に
            // 流し込み、 PR-560 の pipefail 安全策を維持する (= -ex = errexit + xtrace、
            // 元 shebang `#!/bin/bash -xe` と同等)。
            commands: [
              `bash -ex <<'TENANT_UPDATE_SCRIPT_EOF'\n${fs.readFileSync(TENANT_UPDATE_SCRIPT_PATH, "utf8")}\nTENANT_UPDATE_SCRIPT_EOF`,
            ],
          },
        },
      }),
    });
    this.provisioningCodeBuildProjectName = codeBuildProject.projectName;

    // Add Permissions.
    // Issue #857 justify: SBT vendored — provisioning CodeBuild は per-tenant CFn stack を
    // deploy するため必要な全 AWS service への access が要る。 upstream pattern と完全互換に
    // 保つため Resource/Action ともに `*` を残す。 cross-account 化で AssumeRole に絞る予定。
    codeBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["*"],
      }),
    );

    // Define CodePipeline.
    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: "tenkacloud-saas-pipeline",
      artifactBucket: artifactsBucket,
    });

    // Source
    const sourceOutput = new codepipeline.Artifact();

    // Add the Source stage.
    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.S3SourceAction({
          actionName: "S3_Source",
          bucket: sourceCodeBucket,
          bucketKey: props.sourceZip,
          output: sourceOutput,
          variablesNamespace: "SourceVariables",
          trigger: codepipeline_actions.S3Trigger.POLL,
        }),
      ],
    });

    const deployOutput = new codepipeline.Artifact();

    // Add PrepDeploy stage to retrieve tenant data from dynamoDB.
    pipeline.addStage({
      stageName: "PrepDeploy",
      actions: [
        new codepipeline_actions.LambdaInvokeAction({
          actionName: "PrepareDeployment",
          lambda: lambdaFunctionPrep,
          outputs: [deployOutput],
          userParameters: {
            artifact: "Artifact_Build_Build-Serverless-SaaS",
            s3_source_version_id: "#{SourceVariables.VersionId}",
          },
        }),
      ],
    });

    // Create Lambda iterator to cycle through waved deployments.
    const lambdaFunctionIterator = new lambda.Function(this, "WaveIterator", {
      logGroup: new logs.LogGroup(this, "WaveIteratorLogGroup", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      handler: "iterator.lambda_handler",
      runtime: TENANT_PIPELINE_LAMBDA_RUNTIME,
      code: lambda.Code.fromAsset(handlersPath, { exclude: ["*.json"] }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    });

    // logGroupName は省略して CFn auto-generate に任せる。
    // 旧コードは `/aws/vendedlogs/states/StepFunctionLogging` を hardcode していて、
    // 同 account 内に複数 deploy / 旧 stack 残骸との衝突 (= AlreadyExists) を起こしていた。
    // CFn auto-name は `<stack>-stepFunctionLG-<hash>` で stack スコープに閉じる。
    const stepfunctionLogGroup = new logs.LogGroup(this, "stepFunctionLG");

    const approvalQueue = new sqs.Queue(this, "ApprovalQueue", {
      enforceSSL: true,
    });

    // Step function needs permissions to create resources
    const sfnPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["s3:ListBucket", "s3:GetObjectVersion"],
          resources: [artifactsBucket.bucketArn, sourceCodeBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          resources: [`${artifactsBucket.bucketArn}/*`, `${sourceCodeBucket.bucketArn}/*`],
          actions: ["s3:*Object"],
        }),
        // Issue #857 justify: SBT vendored — Step Functions が per-tenant deploy 中に
        // 動的に作る AWS resource (= CFn stack / Lambda / API Gateway / DDB / etc.) の ARN は
        // synth 時に knowable でない。 upstream pattern を保つため Resource: "*" を維持。
        new iam.PolicyStatement({
          resources: ["*"],
          actions: [
            "logs:*",
            "cloudformation:DescribeStacks",
            "cloudformation:CreateStack",
            "cloudformation:UpdateStack",
            "cloudformation:CreateChangeSet",
            "cloudwatch:PutMetricAlarm",
            "cloudwatch:PutMetricAlarm",
            "lambda:*",
            "apigateway:*",
            "dynamodb:*",
            "iam:GetRole",
            "iam:UpdateRole",
            "iam:DeleteRole",
            "iam:CreateRole",
            "iam:ListRoles",
            "iam:PassRole",
            "iam:GetPolicy",
            "iam:PassRole",
            "iam:UpdatePolicy",
            "iam:DetachRolePolicy",
            "iam:AttachRolePolicy",
            "iam:DeleteRolePolicy",
            "iam:DeletePolicy",
            "iam:PutRolePolicy",
            "iam:GetRolePolicy",
            "codedeploy:*",
            "codebuild:StartBuild",
            "sqs:sendmessage",
          ],
        }),
      ],
    });

    const stepfunctionDeploymentRole = new iam.Role(this, "StepFunctionRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      description: "Role assumed by deployment state machine",
      inlinePolicies: {
        deployment_policy: sfnPolicy,
      },
    });

    const filePath = path.join(import.meta.dirname, "deployemntstatemachine.asl.json");
    const file = fs.readFileSync(filePath);

    new stepfunctions.CfnStateMachine(this, "DeploymentCfnStateMachine", {
      roleArn: stepfunctionDeploymentRole.roleArn,
      // the properties below are optional
      definitionString: file.toString(),
      definitionSubstitutions: {
        ITERATOR_LAMBDA_ARN: lambdaFunctionIterator.functionArn,
        APPROVAL_QUEUE_URL: approvalQueue.queueUrl,
        TENANT_MAPPING_TABLE: props.tenantMappingTable.tableName,
        CODE_BUILD_PROJECT_NAME: codeBuildProject.projectName,
      },
      stateMachineName: deploymentStateMachineName,
      stateMachineType: "STANDARD",
      tracingConfiguration: {
        enabled: true,
      },
      loggingConfiguration: {
        level: "ERROR",
        destinations: [
          {
            cloudWatchLogsLogGroup: { logGroupArn: stepfunctionLogGroup.logGroupArn },
          },
        ],
      },
    });

    const stateMachine = stepfunctions.StateMachine.fromStateMachineName(
      this,
      "DeploymentStateMachine",
      deploymentStateMachineName,
    );

    const stepFunctionAction = new codepipeline_actions.StepFunctionInvokeAction({
      actionName: "InvokeStepFunc",
      stateMachine: stateMachine,
      stateMachineInput: codepipeline_actions.StateMachineInput.filePath(
        deployOutput.atPath("output.json"),
      ),
    });

    pipeline.addStage({
      stageName: "InvokeStepFunctions",
      actions: [stepFunctionAction],
    });

    new cdk.CfnOutput(this, "ServerlessSaaSPipeline", {
      value: pipeline.pipelineName,
    });
  }
}
