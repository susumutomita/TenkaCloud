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
 * 問題 CFn テンプレートを deploy する CodeBuild Project。MVP-1 で導入。
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
 *   - `DELETE_EXPECTED_AWS_ACCOUNT_ID`: stack が実在する account (delete 時のみ、#1797)
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

  /** CloudFormation execution role passed via `aws cloudformation deploy --role-arn`. */
  public readonly cfnExecRole: iam.Role;

  constructor(scope: Construct, id: string, props: DeployCodeBuildProjectProps) {
    super(scope, id);

    // #1381: CloudFormation 実行ロール。 問題テンプレが作る任意リソース (EC2 / IAM Role / S3 等)
    // を CFn が create するための広域権限はこの **CFn 専用 service role** に閉じ込め、 CodeBuild role
    // からは剥がす。 CodeBuild は同一 account deploy 時に `aws cloudformation deploy --role-arn` で
    // この role を PassRole するだけ (= build script injection が直接 iam:CreateRole 等を呼べない)。
    // 注: 悪意ある問題テンプレは CFn 経由で依然 admin IAM を作れる (= テンプレ境界の信頼は別問題、
    // テンプレ審査 #1353 で担保)。 本変更が塞ぐのは「CodeBuild role 自体 = 実質 account admin」の方。
    this.cfnExecRole = new iam.Role(this, "CfnExecRole", {
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
      inlinePolicies: {
        ResourceCreation: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ec2:*", "iam:*", "ssm:*", "logs:*", "s3:*", "events:*", "lambda:*"],
              // justify: (#1381) 問題テンプレが作る任意リソースを CFn が create するための広域権限。
              // CodeBuild role からは剥がし、 cloudformation.amazonaws.com だけが assume できるこの
              // 専用 role に閉じ込めた (= PassRole 条件付き)。 テンプレ自体の信頼境界は審査 #1353 で担保。
              resources: ["*"],
            }),
          ],
        }),
      },
    });

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
        // #1797: delete 時に credentials の account と stack の account の一致を検証する。
        // 空文字 default = 検証 skip (在来 event との後方互換)。
        DELETE_EXPECTED_AWS_ACCOUNT_ID: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
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
        // #1381: same-account deploy で `aws cloudformation deploy --role-arn` に渡す CFn 実行ロール。
        // cross-account 経路 (COMPETITOR_ROLE_ARN set) では使わない (assumed role の権限で動く)。
        CFN_EXEC_ROLE_ARN: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: this.cfnExecRole.roleArn,
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

    const stack = Stack.of(this);

    // #1381: stack 操作系の CFn action は deploy stack の命名規約 `tc-{problemSlug}-{teamSlug}`
    // (= battles-common.sh build_name_prefix、 contract `^tc-[a-z0-9]+(-[a-z0-9]+)+$`) に scope する。
    // region は deploy 先が可変なので `*`。 これにより CodeBuild role は自分が作る tc-* stack 以外を
    // 操作できない。
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
          "cloudformation:CreateChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:DeleteChangeSet",
          "cloudformation:ListChangeSets",
          "cloudformation:ListStackResources",
        ],
        resources: [`arn:aws:cloudformation:*:${stack.account}:stack/tc-*/*`],
      }),
    );
    // template introspection 系 (`GetTemplateSummary` 等) は IAM の resource-level 制約を
    // サポートしないため `*` 据え置き (= `aws cloudformation deploy` が parameter/capability 検出で叩く)。
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:GetTemplateSummary"],
        // justify: (#1381) GetTemplateSummary は IAM の resource-level 制約をサポートしない
        // (AWS API design)。 stack ARN に絞れないため `*` 据え置き。 stack 操作系は別 statement で tc-* に scope 済。
        resources: ["*"],
      }),
    );

    // #1381: 問題テンプレが作る任意リソースの広域権限は CodeBuild role からは付けず、 CFn 実行ロール
    // (cfnExecRole) に閉じ込めた。 CodeBuild は same-account deploy 時にその role を CFn に PassRole
    // するだけ (= cloudformation.amazonaws.com にのみ渡せるよう条件付き)。
    this.project.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [this.cfnExecRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
        },
      }),
    );

    // Phase 2.2 (Issue #459): cross-account 経路。CodeBuild script (deploy-battles.sh /
    // delete-battles.sh) が:
    //   1. SSM SecureString から ExternalId を read (= `ssm:GetParameter` + `kms:Decrypt`)
    //   2. `arn:aws:iam::<account>:role/TenkaCloud-*` に AssumeRole (with ExternalId)
    //   3. 取得した tmp credentials で `aws cloudformation deploy` を target account に実行
    // を行うため、本 Project Role に各権限を付与する。
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
