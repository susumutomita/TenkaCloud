import {
  type IUserPool,
  OAuthScope,
  ResourceServerScope,
  UserPoolResourceServer,
} from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import {
  CAPABILITY_RESOURCE_SERVER_ID,
  CAPABILITY_SCOPE_NAMES,
  MACHINE_CAPABILITIES,
  type MachineCapability,
} from "../problem-deploy/handlers/shared/machine-scopes.js";

/**
 * Issue #2948: machine (M2M) capability の Cognito resource server。
 *
 * ## default OFF の安全性は暗号論的である
 *
 * `features.machineTokenPath` が false のとき本 construct は生成されない。resource server が
 * 存在しなければ **Cognito はそもそも `tenkacloud/*` scope を発行できない** ため、handler 側の
 * machine 分岐は到達不能になる。「設定が空だから安全」ではなく「発行できないから安全」であり、
 * 安全性の質が違う。CDK test がこれを pin する。
 *
 * ## bind resource server はここで作らない
 *
 * per-tenant の `tc-tenant-<tenantId>` resource server は **runtime 作成** (= `scripts/
 * issue-machine-client.sh`) である。CFn 管理にすると次回 `cdk deploy` が scope list を空へ
 * reconcile して発行済み token を全滅させる。同時に、CFn 管理外であることが
 * `delete-resource-server` = deploy 不要の kill switch を成立させている。
 *
 * ## 既存 UserPool / UserPoolClient には触らない
 *
 * `identity-provider.ts` を一切変更せず、tenant stack scope で `UserPoolResourceServer` を
 * 足すだけにする。UserPool と human UserPoolClient が REPLACE されれば全 tenant admin が
 * ログアウトする事故になるため、これは意図的な制約である。
 */
export class MachineIdentity extends Construct {
  public readonly resourceServer: UserPoolResourceServer;
  /** capability → API Gateway method に渡す `OAuthScope`。 */
  public readonly capabilityScopes: Readonly<Record<MachineCapability, OAuthScope>>;

  constructor(scope: Construct, id: string, props: { userPool: IUserPool }) {
    super(scope, id);

    const scopes = MACHINE_CAPABILITIES.map(
      (capability) =>
        new ResourceServerScope({
          scopeName: CAPABILITY_SCOPE_NAMES[capability],
          scopeDescription: `TenkaCloud machine capability: ${capability}`,
        }),
    );

    this.resourceServer = new UserPoolResourceServer(this, "MachineCapabilities", {
      userPool: props.userPool,
      identifier: CAPABILITY_RESOURCE_SERVER_ID,
      userPoolResourceServerName: CAPABILITY_RESOURCE_SERVER_ID,
      scopes,
    });

    const entries = MACHINE_CAPABILITIES.map((capability, index) => [
      capability,
      OAuthScope.resourceServer(this.resourceServer, scopes[index] as ResourceServerScope),
    ]);
    this.capabilityScopes = Object.fromEntries(entries) as Readonly<
      Record<MachineCapability, OAuthScope>
    >;
  }
}
