import { Duration, Stack } from "aws-cdk-lib";
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
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface DeployCodeBuildProjectProps {
  /**
   * `install.sh` が repo を zip して upload する S3 bucket (`serverless-saas-{account}-
   * {region}`)。CodeBuild は ここから source.zip を取り出して `scripts/deploy-battles.sh`
   * を実行する。同一 SaaS infra で既に使われている bucket を流用する。
   */
  readonly sourceBucket: IBucket;
  /** `install.sh` が upload する zip key (default: `source.zip`)。 */
  readonly sourceObjectKey: string;
  /**
   * 本 Project 単体での concurrent build 上限 (issue #538: Bulk Deploy 並列度)。
   *
   * 未指定 (= default) なら CFn `ConcurrentBuildLimit` を出力しない = AWS account 全体の
   * concurrent build quota (region default 60) を全部 本 Project で使い切れる挙動を
   * 維持する。
   *
   * Bulk Deploy (`POST /events/:id/deploy`) は N × M (teams × problems) ぶんの
   * `DeployCreateRequested` event を EventBridge に fan-out し、各 event が 1 Step
   * Functions execution → 1 CodeBuild build を起動する (= 上流は完全並列)。実 throughput
   * の hard cap は次の順で効く:
   *   1. **CodeBuild concurrent build quota** (region default 60) — 本 Project が握る上限
   *   2. CFn `CreateStack` API rate (target account の region 単位)
   *   3. AssumeRole が触る各 AWS サービスの API rate
   *
   * 30 問 × 25 team = 750 stacks の deploy を 30 分以内に終わらせたい (issue #538 AC)
   * 場合、quota 60 のままでは ⌈750 / 60⌉ = 13 batch 必要 = batch 1 つあたり 1-15 min
   * (CFn の重さ次第)。Service Quota request で 200/500 に上げた上で、本プロパティに
   * 同値以下の cap を渡すと「他 stack 用 CodeBuild が枯渇しない」ガードになる。
   *
   * dev / sandbox では小さい値 (例: 5) に絞ってコスト暴走を防ぐ用途にも使う。
   */
  readonly concurrentBuildLimit?: number;
  /**
   * Phase 2.2 (Issue #459): SSM SecureString path 構築用 env (例: `development`)。
   * CodeBuild Role に `ssm:GetParameter` を付与する scope (= 同 tenant prefix) を作る。
   */
  readonly environmentName: string;
}

/**
 * 問題 CFn テンプレートを deploy する CodeBuild Project。MVP-1 (ADR-001 PR-2) で導入。
 *
 * SBT の `BashJobRunner` (= ScriptJob) 同型: Step Functions の `CodeBuildStartBuild`
 * task が本 Project を `RUN_JOB` integration pattern で起動し、`scripts/deploy-battles.sh`
 * を実行する。
 *
 * 実行時の入力は env 経由 (Step Functions が `environmentVariablesOverride` で渡す):
 *   - `OPERATION`: `create` (default) または `delete`。create / delete を 1 Project で兼用。
 *   - `BATTLE_PROBLEM_DIR`: 例 `problems/challenges/hello-world` (create 時のみ)
 *   - `TEAM_SLUG`: 例 `demo-team` (create 時のみ)
 *   - `DELETE_STACK_NAME`: CFn StackName / StackId (delete 時のみ)
 *   - `DELETE_REGION`: delete 対象 region (delete 時のみ)
 *   - `TENKACLOUD_CORRELATION_ID`: operator trace 用。現状は deploy jobId と同値。
 *
 * 同一 AWS account 内 deploy のみ (MVP-1 制約)。Phase 2 で cross-account になったら
 * IAM Role に `sts:AssumeRole` 等を足す。
 *
 * **並列度 (#538)**: 本 Project は `ConcurrentBuildLimit` 未指定が default で、AWS account
 * 全体の concurrent build quota (region default 60) をフル活用する。Bulk Deploy で
 * 750 stacks を投入しても、CodeBuild service 側で 60 並列に自動 throttle される。
 * 詳細は `props.concurrentBuildLimit` の docs を参照。
 */
export class DeployCodeBuildProject extends Construct {
  public readonly project: Project;

  constructor(scope: Construct, id: string, props: DeployCodeBuildProjectProps) {
    super(scope, id);

    this.project = new Project(this, "Project", {
      description: "TenkaCloud problem deploy executor (runs scripts/deploy-battles.sh).",
      timeout: Duration.minutes(60),
      // #538: 並列 build 上限を operator が tune できるようにする。未指定なら CFn property
      // 自体を出力しない = AWS account 全体の concurrent build quota をフル活用する挙動を維持。
      ...(props.concurrentBuildLimit !== undefined
        ? { concurrentBuildLimit: props.concurrentBuildLimit }
        : {}),
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
        OPERATION: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "create",
        },
        BATTLE_PROBLEM_DIR: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
        TEAM_SLUG: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
        DELETE_STACK_NAME: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
        DELETE_REGION: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "<unset-overridden-by-step-functions>",
        },
        // Phase 2.2 (Issue #459): cross-account AssumeRole metadata。State Machine が
        // event detail から override する。空文字 default = same-account fallback。
        COMPETITOR_ROLE_ARN: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
        EXTERNAL_ID_SSM_PARAMETER: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
        DEPLOY_REGION: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
        TENKACLOUD_ACCOUNT_ID: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: Stack.of(this).account,
        },
        PROBLEM_EXTERNAL_ID: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
        TENKACLOUD_CORRELATION_ID: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
      },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              'echo "OPERATION=$OPERATION  BATTLE_PROBLEM_DIR=$BATTLE_PROBLEM_DIR  TEAM_SLUG=$TEAM_SLUG  DELETE_STACK_NAME=$DELETE_STACK_NAME  DELETE_REGION=$DELETE_REGION  AWS_REGION=$AWS_REGION"',
              // OPERATION で create / delete を分岐。default (env 未設定 / 空) は create。
              'if [ "$OPERATION" = "delete" ]; then bash scripts/delete-battles.sh "$DELETE_STACK_NAME" "$DELETE_REGION"; else bash scripts/deploy-battles.sh "$BATTLE_PROBLEM_DIR"; fi',
            ],
          },
        },
      }),
    });

    // 同一 account 内の CFn deploy 権限を Project Role に付与する。MVP-1 は same-account
    // のみなので Resource は account 内全リソースを許可 (CFn が必要な権限は問題テンプレ次第)。
    // Phase 2 で cross-account になったら ここを sts:AssumeRole に絞り、target account 側で
    // CFn 権限を持たせる。
    // Issue #857 justify: same-account CFn deploy で問題 stack ARN を synth 時に決定不能
    // (= competitor が CodeBuild script から動的に CreateStack するため)。 Phase 2 cross-account
    // で AssumeRole + 競技者側 Role に CFn 権限を持たせる移行が予定済 (= MVP-1 の一時許容)。
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
        // Issue #857 justify: same-account の動的 stack ARN を synth 時に決定不能 (= 上のコメント参照)
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

    // Phase 2.2 (Issue #459): cross-account 経路。CodeBuild script (deploy-battles.sh /
    // delete-battles.sh) が:
    //   1. SSM SecureString から ExternalId を read (= `ssm:GetParameter` + `kms:Decrypt`)
    //   2. `arn:aws:iam::<account>:role/TenkaCloud-*` に AssumeRole (with ExternalId)
    //   3. 取得した tmp credentials で `aws cloudformation deploy` を target account に実行
    // を行うため、本 Project Role に各権限を付与する。
    const stack = Stack.of(this);
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [ssmArn],
      }),
    );
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          // CompetitorAccountsApiLambda と同じ pattern。StringLike で wildcard を許容。
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn },
        },
      }),
    );
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        // 競技者アカウントの IAM Role 名 pattern (= `TenkaCloud-*` prefix 必須)。
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );
  }
}
