import { Duration } from "aws-cdk-lib";
import {
  BuildEnvironmentVariableType,
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface DeployCodeBuildProjectProps {
  /**
   * `install.sh` が repo を zip して upload する S3 bucket (`serverless-saas-{account}-
   * {region}`)。CodeBuild は ここから source.zip を取り出して `scripts/deploy-battles.sh`
   * を実行する。同一 SaaS infra で既に使われている bucket を流用する。
   */
  readonly sourceBucket: IBucket;
  /** `install.sh` が upload する zip key (default: `source.zip`)。 */
  readonly sourceObjectKey: string;
}

/**
 * 問題 CFn テンプレートを deploy する CodeBuild Project。MVP-1 (ADR-001 PR-2) で導入。
 *
 * SBT の `BashJobRunner` (= ScriptJob) 同型: Step Functions の `CodeBuildStartBuild`
 * task が本 Project を `RUN_JOB` integration pattern で起動し、`scripts/deploy-battles.sh`
 * を実行する。
 *
 * 実行時の入力は env 経由 (Step Functions が `environmentVariablesOverride` で渡す):
 *   - `BATTLE_PROBLEM_DIR`: 例 `problems/challenges/hello-world`
 *   - `TEAM_SLUG`: 例 `demo-team`
 *
 * 同一 AWS account 内 deploy のみ (MVP-1 制約)。Phase 2 で cross-account になったら
 * IAM Role に `sts:AssumeRole` 等を足す。
 */
export class DeployCodeBuildProject extends Construct {
  public readonly project: Project;

  constructor(scope: Construct, id: string, props: DeployCodeBuildProjectProps) {
    super(scope, id);

    this.project = new Project(this, "Project", {
      description: "TenkaCloud problem deploy executor (runs scripts/deploy-battles.sh).",
      timeout: Duration.minutes(60),
      // S3 から source.zip を取って展開する。`install.sh` が事前に upload する。
      source: Source.s3({
        bucket: props.sourceBucket,
        path: props.sourceObjectKey,
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2023_5,
        computeType: ComputeType.SMALL,
        // aws CLI と jq は Amazon Linux 2023 image に標準で含まれる。
      },
      environmentVariables: {
        // Step Functions が environmentVariablesOverride で実行時に毎回上書きする。
        // CodeBuild 側で必須宣言するため placeholder default を入れる。
        BATTLE_PROBLEM_DIR: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
        TEAM_SLUG: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
      },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              'echo "BATTLE_PROBLEM_DIR=$BATTLE_PROBLEM_DIR  TEAM_SLUG=$TEAM_SLUG  AWS_REGION=$AWS_REGION"',
              'bash scripts/deploy-battles.sh "$BATTLE_PROBLEM_DIR"',
            ],
          },
        },
      }),
    });

    // 同一 account 内の CFn deploy 権限を Project Role に付与する。MVP-1 は same-account
    // のみなので Resource は account 内全リソースを許可 (CFn が必要な権限は問題テンプレ次第)。
    // Phase 2 で cross-account になったら ここを sts:AssumeRole に絞り、target account 側で
    // CFn 権限を持たせる。
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResource",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
          "cloudformation:GetTemplateSummary",
          "cloudformation:CreateChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:DeleteChangeSet",
          "cloudformation:ListChangeSets",
          "cloudformation:ListStackResources",
        ],
        resources: ["*"],
      }),
    );

    // `security-battle-royale` 等の問題テンプレが作るリソース (EC2 / VPC / IAM Role 等)
    // を CFn が自前で create するための権限。MVP-1 は same-account なので Project Role
    // が直接これらを持つ必要がある。最小権限化は問題テンプレが固まってから別途検討。
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:*", "iam:*", "ssm:*", "logs:*", "s3:*", "events:*", "lambda:*"],
        resources: ["*"],
      }),
    );
  }
}
