import { Duration } from "aws-cdk-lib";
import { AccountRootPrincipal, ManagedPolicy, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * 競技者が AWS Console にワンクリック login するためのフェデレーション先 IAM Role。
 *
 * Participant Portal Lambda が `sts:AssumeRole` してこの Role の temp 認証情報を
 * 取得し、`signin.aws.amazon.com/federation` 経由で SigninToken を発行 → 競技者は
 * 自前の AWS ログイン無しで AWS Console に federate される。
 *
 * 権限スコープ: `ReadOnlyAccess`。Trust は同 account root (= Lambda 側の policy で
 * 二重ゲート、cross-account は別 Role でカバー)。MaxSession 1h = federation TTL と一致。
 */
export class ConsoleViewerRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.role = new Role(this, "Role", {
      assumedBy: new AccountRootPrincipal(),
      maxSessionDuration: Duration.hours(1),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
      description: "Federation target for participant AWS Console one-click login.",
    });
  }
}
