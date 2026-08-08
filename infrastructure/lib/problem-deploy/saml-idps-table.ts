import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Issue #1312: SAML IdP CRUD 用の DDB Table。
 *
 * IdP store。 1 行 = 1 (scope, idpId)。 両 plane が **別 stack に別 table** を立てて使う
 * (= storage は共有しない。 scope 値だけが plane を区別する)。
 *
 *   PK: `pk` (string) — scope 識別子
 *     - Application Plane (tenant scope): `tenantId` (例: `local` / ULID)
 *     - Control Plane (system scope): `SYSTEM` (#2941 で `ControlPlaneStack` が本 Construct を
 *       instantiate し、 `/admin/idp` CRUD Lambda の store にする)
 *   SK: `sk` (string) — `idpId` (scope 内一意)
 *
 * 属性名は `infrastructure/lib/control-plane/handlers/idp-handler/ddb-store.ts` の lower-case
 * `pk` / `sk` field 配置と整合させる (= handler 側 PutCommand / GetCommand の Key 名と一致)。
 *
 * Sizing: `SAML_IDP_LIMIT_PER_USERPOOL = 25` (saml-utils の limit)。 list は 1 Query で完結。
 * PROVISIONED 1/1 (DynamoDbLowCapacity Aspect で更に均す)。 IdP CRUD は admin 操作のみで極低 QPS、
 * Free Tier 25 RCU/WCU に十分収まる。
 *
 * 削除方針: RETAIN。 stack delete で SAML federation 設定を意図せず消さない (= replay 不可)。
 */
export class SamlIdpsTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });
  }
}
