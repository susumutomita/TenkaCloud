import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface DeployWorkerRoleProps {
  /** 後段 PR で作成される Lambda 群が CRUD する Deployments テーブルの ARN。 */
  readonly deploymentsTableArn: string;
  /**
   * SBT control-plane の EventBus ARN。Lambda が deploy 系イベントを put する。
   */
  readonly eventBusArn: string;
}

/**
 * 問題 deploy 系 Lambda が引き受ける IAM Role。
 *
 * 用途:
 *   - 競技者アカウントの `TenkaCloud-CompetitorDeploy-Role` を AssumeRole する
 *     (cross-account)
 *   - Deployments table を CRUD する
 *   - SBT EventBus に deploy 系イベントを put する
 *   - CloudWatch Logs に書く (managed policy)
 *
 * AssumeRole の許可は `*` (どの account の role でも引ける) にしている。理由:
 *   - 競技者アカウントは UI 入力で動的に決まり、deploy ごとに異なる
 *   - Resource を絞ると無限に拡張するか、deploy のたびに Role を更新する運用になる
 *   - 引かれる側 (競技者の Bootstrap Role) で trust + ExternalId で絞り、
 *     Confused Deputy はそちら側で防ぐ
 *
 * 後段 PR (PR-C / D / E) で Lambda 関数が増えるたびに、本 Role を assume させる
 * 形で再利用する。
 */
export class DeployWorkerRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: DeployWorkerRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "TenkaCloud problem deploy worker (cross-account AssumeRole + DDB + EventBus)",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      inlinePolicies: {
        AssumeCompetitorRoles: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["sts:AssumeRole"],
              resources: ["arn:aws:iam::*:role/TenkaCloud-CompetitorDeploy-Role"],
            }),
          ],
        }),
        DeploymentsTableAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:DeleteItem",
                "dynamodb:Query",
                "dynamodb:Scan",
                "dynamodb:BatchGetItem",
                "dynamodb:BatchWriteItem",
              ],
              resources: [props.deploymentsTableArn, `${props.deploymentsTableArn}/index/*`],
            }),
          ],
        }),
        EventBusPublish: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["events:PutEvents"],
              resources: [props.eventBusArn],
            }),
          ],
        }),
      },
    });
  }
}
