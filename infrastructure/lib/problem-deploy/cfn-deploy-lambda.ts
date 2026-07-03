import * as path from "node:path";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface CfnDeployLambdaProps {
  /**
   * SSM SecureString path 構築用の environment 名 (Issue #459 / ADR-002)。
   * `/{environmentName}/tenants/{tenantId}/external-id` の prefix。 ExternalId param の
   * `ssm:GetParameter` scope を作る。
   */
  readonly environmentName: string;
  /**
   * 問題 `template.yaml` / `metadata.json` を取得する source bucket 名 (= CodeBuild と同じ
   * `serverless-saas-{account}-{region}`)。 `s3:GetObject` を本 bucket に限定する。
   */
  readonly sourceBucketName: string;
}

/**
 * Issue #2291 (ADR-049 §9): 問題 CFn テンプレを deploy する **Lambda**。CodeBuild path
 * (`DeployCodeBuildProject` + `deploy-battles.sh`) の Lambda 版で、`deployViaLambda` feature
 * flag が true のときだけ `buildDeployPipeline` が生成する (default OFF = 既存 CodeBuild path、
 * CFn テンプレ byte 互換)。
 *
 * IAM は `DeployCodeBuildProject` の build role を **そのまま踏襲** した least-privilege
 * (#1381 の privilege split):
 *   - CFn stack 操作は命名規約 `tc-*` に scope
 *   - `iam:PassRole` は CFn 専用 exec role にのみ、`PassedToService=cloudformation` 条件付き
 *   - `sts:AssumeRole` は `arn:aws:iam::*:role/TenkaCloud-*` に限定 (ExternalId 必須は handler 側)
 *   - `ssm:GetParameter` は ExternalId param、`kms:Decrypt` は同 param の EncryptionContext 条件付き
 *   - `s3:GetObject` は source bucket に限定 (template / metadata 取得)
 *
 * 任意リソース作成の広域権限は Lambda role からは剥がし、CFn 専用 service role
 * ({@link cfnExecRole}) に閉じ込める。same-account deploy 時に CreateStack へ PassRole する。
 *
 * #2291 progress log: この Lambda は deploy/delete の進捗を jobId 名の CloudWatch stream に書き、
 * participant portal の `GET /portal/me/deploy-logs` (deploy-logs.ts) が {@link jobLogGroup} を
 * env `DEPLOY_JOB_LOG_GROUP` 経由で読み戻す。CodeBuild build log を持たない Lambda 経路でも
 * 競技者が deploy 進捗を見られるようにするための専用 log group。write 権限は本 group に限定した
 * `logs:CreateLogStream` / `logs:PutLogEvents` のみ (function 自身の log group は Basic exec role が担保)。
 */
export class CfnDeployLambda extends Construct {
  public readonly fn: NodejsFunction;

  /** CloudFormation 実行 role (same-account CreateStack で `RoleARN` に渡す)。 */
  public readonly cfnExecRole: iam.Role;

  /**
   * #2291: deploy/delete 進捗を jobId 名 stream に書く専用 log group。participant portal Lambda が
   * この group を read scope として受け取り (`build-participant-portal-subsystem.ts` 経由)、
   * `deploy-logs.ts` が jobId stream を `logs:GetLogEvents` で stream する。
   */
  public readonly jobLogGroup: LogGroup;

  constructor(scope: Construct, id: string, props: CfnDeployLambdaProps) {
    super(scope, id);

    const stack = Stack.of(this);

    // #2291: deploy 進捗の jobId 名 stream 置き場。1 ヶ月保持で cost を抑え、stack 削除で消す。
    this.jobLogGroup = new LogGroup(this, "JobLogGroup", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // #1381 踏襲: 問題テンプレが作る任意リソースの広域権限は CFn 専用 service role に閉じ込める。
    this.cfnExecRole = new iam.Role(this, "CfnExecRole", {
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
      inlinePolicies: {
        ResourceCreation: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ec2:*", "iam:*", "ssm:*", "logs:*", "s3:*", "events:*", "lambda:*"],
              // justify: (#1381) 問題テンプレが作る任意リソースを CFn が create するための広域権限。
              // Lambda role からは剥がし、 cloudformation.amazonaws.com だけが assume できるこの
              // 専用 role に閉じ込めた (= PassRole 条件付き)。 テンプレ自体の信頼境界は審査 #1353 で担保。
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/cfn-deploy-handler/index.ts"),
      // pre-delete の bounded wait (最大 4 分) を挟むため 5 分。 詳細は create-stack.ts の TODO 参照。
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        SOURCE_BUCKET_NAME: props.sourceBucketName,
        TENKACLOUD_ACCOUNT_ID: stack.account,
        CFN_EXEC_ROLE_ARN: this.cfnExecRole.roleArn,
        // #2291: handler が jobId 名 stream に進捗を書く先。deploy-logs.ts が同 env で read する。
        DEPLOY_JOB_LOG_GROUP: this.jobLogGroup.logGroupName,
      },
    });

    // #2291: 進捗書き込みは本 job log group への CreateLogStream / PutLogEvents に限定 (least-privilege)。
    // function 自身の log group は AWSLambdaBasicExecutionRole が担保する (= 別 group、ここでは触らない)。
    // stream (`:*`) と group ARN の両方を対象にする (PutLogEvents は stream ARN で評価される)。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [this.jobLogGroup.logGroupArn, `${this.jobLogGroup.logGroupArn}:*`],
      }),
    );

    // #1381 踏襲: stack 操作系 CFn action は命名規約 `tc-*` に scope。
    this.fn.addToRolePolicy(
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
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:GetTemplateSummary"],
        // justify: (#1381) GetTemplateSummary は IAM の resource-level 制約をサポートしない
        // (AWS API design)。 stack ARN に絞れないため `*` 据え置き。 stack 操作系は別 statement で tc-* に scope 済。
        resources: ["*"],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [this.cfnExecRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
        },
      }),
    );

    // Phase 2.2 (Issue #459) 踏襲: SSM SecureString から ExternalId を read + AssumeRole。
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
        // 競技者アカウントの IAM Role 名 pattern (= `TenkaCloud-*` prefix 必須)。ExternalId 必須は handler 側で担保。
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );

    // 問題 template.yaml / metadata.json を取得する GetObject を source bucket に限定。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${props.sourceBucketName}/*`],
      }),
    );
  }
}
