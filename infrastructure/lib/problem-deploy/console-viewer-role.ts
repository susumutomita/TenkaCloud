import { Duration } from "aws-cdk-lib";
import {
  AccountRootPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * 競技者が AWS Console にワンクリック login するためのフェデレーション先 IAM Role。
 *
 * Participant Portal Lambda が `sts:AssumeRole` してこの Role の temp 認証情報を
 * 取得し、`signin.aws.amazon.com/federation` 経由で SigninToken を発行 → 競技者は
 * 自前の AWS ログイン無しで AWS Console に federate される。
 *
 * 旧実装は `ReadOnlyAccess` AWS managed policy を付与していたが、これだと CodePipeline /
 * CodeBuild / Cognito UserPool list / 他テナント `tc-*` stack 等、 operator の deploy 業務
 * 情報が競技者から丸見えだった (#704)。本 Role は `tc-*` 接頭辞リソースに対する
 * 最小権限のみを inline で持つ。 さらに sso.ts の session policy で team 自身の
 * namePrefix に絞る。
 */
export class ConsoleViewerRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.role = new Role(this, "Role", {
      assumedBy: new AccountRootPrincipal(),
      maxSessionDuration: Duration.hours(1),
      description: "Federation target for participant AWS Console one-click login (tc-* scoped).",
      inlinePolicies: {
        TcReadOnly: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "cloudformation:DescribeStacks",
                "cloudformation:GetTemplate",
                "cloudformation:ListStackResources",
                "cloudformation:DescribeStackEvents",
                "cloudformation:DescribeStackResource",
                "cloudformation:DescribeStackResources",
              ],
              resources: ["arn:aws:cloudformation:*:*:stack/tc-*"],
            }),
            // ListStacks は ARN 制約不可。 競技者 Console で stack 一覧を表示する
            // ため必要。他チームの `tc-*` stack 名は名前だけ可視 (= leak は名前のみ)、
            // events / resources は上の Resource 制約で gate される。
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["cloudformation:ListStacks"],
              resources: ["*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:GetLogEvents",
                "logs:FilterLogEvents",
              ],
              resources: [
                "arn:aws:logs:*:*:log-group:/aws/lambda/tc-*",
                "arn:aws:logs:*:*:log-group:/aws/lambda/tc-*:log-stream:*",
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["lambda:GetFunction", "lambda:ListFunctions"],
              resources: ["arn:aws:lambda:*:*:function:tc-*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject"],
              resources: ["arn:aws:s3:::tc-*", "arn:aws:s3:::tc-*/*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"],
              resources: ["*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["apigateway:GET"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
  }
}
