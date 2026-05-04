import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface ProblemDeployPipelineProps {
  /**
   * SBT EventManager の eventBus ARN。ControlPlaneStack の `eventBusArn` を渡す。
   * 本 stack 内で `EventBus.fromEventBusArn` で import し、`ProblemDeployRequested`
   * を listen する rule + 完了 event を publish する権限の grant に使う。
   */
  readonly eventBusArn: string;
  /**
   * GameDayDeploymentJob 行を持つ shared DynamoDB table。
   * 完了 handler Lambda が UpdateItem する。AdminApiStack の controlPlaneTable
   * を渡す想定 (cross-stack reference)。
   */
  readonly controlPlaneTable: ITable;
}

/**
 * 問題デプロイパイプライン (CodeBuild ベース)。
 *
 * **役割**: GameDay の admin が UI 上で「全チームに problem を deploy」「失敗した
 * team を retry (redeploy)」「event 終了で全 stack を teardown」のいずれかを起動
 * すると、problem-service が `ProblemDeployRequested` を SBT EventBus に publish
 * する。本構造はそれを受けて CodeBuild project を起動し、bash buildspec が:
 *   1. team account の cross-account role を AssumeRole (externalId 付き)
 *   2. ACTION に応じて CFn create/delete を実行
 *   3. 完了時に `problem.deploy.completed` / `problem.deploy.failed` を publish
 * する。
 *
 * **なぜ SBT BashJobRunner を直接使わないか**:
 * `@cdklabs/sbt-aws` の `BashJobRunner` は `incomingEvent` 型が SBT 内部の
 * `DetailType` enum 固定 (ONBOARDING_REQUEST 等)。本イベント
 * (`ProblemDeployRequested`) は TenkaCloud 独自なので、EventBridge rule と
 * CodeBuild project を直接組み立てる。実装パターン (CodeBuild + IAM + Rule)
 * は SBT 内部と同等で、同じ EventBus を共有するので Control Plane / Application
 * Plane の event 経路はそのまま使える。
 *
 * **target account 側の前提**:
 * - `infrastructure/templates/competitor-deploy-role.yaml` を deploy 済みで、
 *   `tenkacloud-competitor-deploy-role` (cross-account role) が存在する。
 * - その role の trust policy で本 stack の CodeBuild role と externalId を許可。
 */
export class ProblemDeployPipelineStack extends cdk.Stack {
  public readonly codeBuildProjectName: string;

  constructor(scope: Construct, id: string, props: ProblemDeployPipelineProps & cdk.StackProps) {
    super(scope, id, props);

    const eventBus = EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn);
    const buildspecScriptPath = path.resolve(__dirname, "..", "..", "..", "scripts", "codebuild", "deploy-problem.sh");
    const buildspecScript = fs.readFileSync(buildspecScriptPath, "utf8");

    const logGroup = new LogGroup(this, "DeployJobLogs", {
      logGroupName: `/aws/codebuild/tenkacloud-problem-deploy-${this.node.addr}`,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CodeBuild project は AssumeRole を呼ぶだけなので最小限の IAM。
    // 実際の CFn 操作は AssumeRole 後の一時 credentials で行うので、当 role
    // 自体には CFn 権限は持たせない (least privilege)。
    const project = new codebuild.Project(this, "DeployJob", {
      projectName: `tenkacloud-problem-deploy-${this.region}`,
      description: "Deploys problem CFn templates to competitor accounts via cross-account AssumeRole.",
      timeout: cdk.Duration.minutes(60),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.SMALL,
      },
      logging: { cloudWatch: { logGroup } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: { commands: ["yum install -y jq || dnf install -y jq"] },
          build: {
            commands: [
              // 起動側で env が全て揃ってる前提。スクリプト本体は heredoc 経由で
              // build env に埋め込む (S3 から fetch しなくていいよう asset 化)。
              `cat <<'__TENKACLOUD_DEPLOY_PROBLEM_EOF__' >/tmp/deploy-problem.sh\n${buildspecScript}\n__TENKACLOUD_DEPLOY_PROBLEM_EOF__`,
              "chmod +x /tmp/deploy-problem.sh",
              "bash /tmp/deploy-problem.sh",
            ],
          },
        },
      }),
    });

    // 自身のアカウント内 STS 経由で **任意の external account** の role を AssumeRole
    // できるようにする。target は incoming event の TARGET_ROLE_ARN で決まり、
    // 信頼関係は target 側の role 設定に依存するので、ここでは sts:AssumeRole を
    // wildcard resource で許可する (実質 target の trust policy が gate)。
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: ["*"],
      }),
    );
    // 完了 event を EventBus に publish する権限。
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [eventBus.eventBusArn],
      }),
    );

    this.codeBuildProjectName = project.projectName;

    // ── EventBridge rule: ProblemDeployRequested → CodeBuild StartBuild ──
    // input transformer で event payload を CodeBuild env vars (PROBLEM_ID 等) に
    // マップする。bash 側はこの env を読んで動く。
    new Rule(this, "ProblemDeployRequestedRule", {
      ruleName: `tenkacloud-problem-deploy-requested-${this.region}`,
      eventBus,
      eventPattern: {
        source: ["tenkacloud.problem-service"],
        detailType: ["ProblemDeployRequested"],
      },
      targets: [
        new targets.CodeBuildProject(project, {
          event: RuleTargetInput.fromObject({
            environmentVariablesOverride: [
              { name: "ACTION", value: cdk.aws_events.EventField.fromPath("$.detail.action"), type: "PLAINTEXT" },
              {
                name: "PROBLEM_ID",
                value: cdk.aws_events.EventField.fromPath("$.detail.problemId"),
                type: "PLAINTEXT",
              },
              { name: "TEAM_ID", value: cdk.aws_events.EventField.fromPath("$.detail.teamId"), type: "PLAINTEXT" },
              { name: "EVENT_ID", value: cdk.aws_events.EventField.fromPath("$.detail.eventId"), type: "PLAINTEXT" },
              { name: "JOB_ID", value: cdk.aws_events.EventField.fromPath("$.detail.jobId"), type: "PLAINTEXT" },
              {
                name: "TARGET_ROLE_ARN",
                value: cdk.aws_events.EventField.fromPath("$.detail.targetRoleArn"),
                type: "PLAINTEXT",
              },
              {
                name: "EXTERNAL_ID",
                value: cdk.aws_events.EventField.fromPath("$.detail.externalId"),
                type: "PLAINTEXT",
              },
              {
                name: "TEMPLATE_URL",
                value: cdk.aws_events.EventField.fromPath("$.detail.templateUrl"),
                type: "PLAINTEXT",
              },
              {
                name: "STACK_NAME",
                value: cdk.aws_events.EventField.fromPath("$.detail.stackName"),
                type: "PLAINTEXT",
              },
              {
                name: "STACK_REGION",
                value: cdk.aws_events.EventField.fromPath("$.detail.region"),
                type: "PLAINTEXT",
              },
              { name: "EVENT_BUS_NAME", value: eventBus.eventBusName, type: "PLAINTEXT" },
            ],
          }),
        }),
      ],
    });

    new cdk.CfnOutput(this, "ProblemDeployCodeBuildProject", {
      value: project.projectName,
      description: "Name of the CodeBuild project that runs ProblemDeployRequested jobs.",
    });

    // ── Completion handler Lambda ──────────────────────────────
    // CodeBuild script の emit_outcome が SBT EventBus に
    // problem.deploy.completed / problem.deploy.failed を publish するので、
    // それを subscribe して GameDayDeploymentJob 行を更新する。
    // UI が job 一覧を polling しているので、これが届かないと永久に "in_progress"
    // のまま残る。
    const completionHandlerCodePath = path.resolve(__dirname, "..", "src");
    const completionHandler = new LambdaFunction(this, "CompletionHandler", {
      functionName: `tenkacloud-problem-deploy-completion-${this.region}`,
      runtime: Runtime.NODEJS_20_X,
      handler: "deploy-completion-handler.handler",
      code: Code.fromAsset(completionHandlerCodePath, {
        // path には他の Python lambda 等も入るので exclude で絞る。
        exclude: ["*.py", "*.test.*", "**/*.test.*"],
      }),
      timeout: cdk.Duration.seconds(15),
      logRetention: RetentionDays.ONE_WEEK,
      environment: {
        DYNAMODB_TABLE_NAME: props.controlPlaneTable.tableName,
      },
    });
    props.controlPlaneTable.grantReadWriteData(completionHandler);

    new Rule(this, "ProblemDeployCompletionRule", {
      ruleName: `tenkacloud-problem-deploy-completion-${this.region}`,
      eventBus,
      eventPattern: {
        source: ["tenkacloud.problem-service"],
        detailType: ["problem.deploy.completed", "problem.deploy.failed"],
      },
      targets: [new targets.LambdaFunction(completionHandler)],
    });

    new cdk.CfnOutput(this, "ProblemDeployCompletionHandlerName", {
      value: completionHandler.functionName,
    });
  }
}
