import { Aws, Duration } from "aws-cdk-lib";
import { ManagedPolicy, type PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * 競技者が AWS Console にワンクリック login するためのフェデレーション先 IAM Role。
 *
 * Participant Portal Lambda が `sts:AssumeRole` してこの Role の temp 認証情報を
 * 取得し、`signin.aws.amazon.com/federation` 経由で SigninToken を発行 → 競技者は
 * 自前の AWS ログイン無しで AWS Console に federate される。
 *
 * 権限スコープ:
 *   - `ReadOnlyAccess` managed policy (= AWS 全 service の read-only)
 *   - 多テナント環境で「他 tenant の deployment が見える」リスクは残るが、操作系
 *     (Create / Modify / Delete) は不可。Phase 4+ で session policy で stack 単位に
 *     scope する余地。
 *
 * Trust:
 *   - 同 account の Lambda role のみ assume 可能 (cross-account は別 Role でカバー)
 *   - MaxSession 1 hour = federation token の TTL と一致
 */
export class ConsoleViewerRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.role = new Role(this, "Role", {
      // 同 account の Lambda が assume できるように root を信頼。Lambda 側の
      // role policy に sts:AssumeRole を別途付ける (= 二重ゲート)。
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withConditions({}),
      maxSessionDuration: Duration.hours(1),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
      description: "Federation target for participant AWS Console one-click login.",
    });
    // assumedBy: 同 account の root を信頼するので Principal を root ARN に書き直す
    // (ServicePrincipal だと service action principal、AssumeRole API には不適)
    const cfn = this.role.node.defaultChild as import("aws-cdk-lib/aws-iam").CfnRole;
    cfn.assumeRolePolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${Aws.ACCOUNT_ID}:root` },
          Action: "sts:AssumeRole",
        },
      ],
    };
  }

  /** 任意の追加 policy を attach するためのインターフェース。 */
  addPolicy(statement: PolicyStatement): void {
    this.role.addToPolicy(statement);
  }
}
