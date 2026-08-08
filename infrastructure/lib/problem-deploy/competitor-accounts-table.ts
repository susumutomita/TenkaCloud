import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

/**
 * tenant 単位で「deploy 許可されている競技者 AWS account」を 1 行で記録する DDB テーブル
 * (Issue #459 / ADR-002 Decision 2.1)。
 *
 * 本テーブルは **メタデータ専用**。ExternalId は同 stack の SSM SecureString に置く
 * (= `secrets-manager-forbidden` enforcement と整合、coppy-paste 経路で漏洩しないため)。
 *
 * Schema:
 *   PK: TENANT#<tenantId>
 *   SK: ACCOUNT#<awsAccountId>     (= 12 桁 AWS Account ID)
 *
 * 主な属性:
 *   tenantId / awsAccountId / region / competitorRoleName / alias? /
 *   verified (boolean) / verifiedAt? / createdAt / updatedAt / createdBy
 *
 * GSI なし (PK 単一で tenant 内一覧を Query、個別取得は Get で SK 直接 lookup)。
 *
 * Capacity / lifecycle:
 *   provisioned 1/1 (`DynamoDbLowCapacity` Aspect で更に均す)。training / 競技
 *   イベント中の QPS 極小、コスト 0 原則を優先する。RETAIN — operator 操作で stack
 *   を delete しても tenant ↔ account 紐付け履歴は残す。
 */
export class CompetitorAccountsTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: DataTableProps = {}) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: props.removalPolicy ?? dataTableRemovalPolicy(undefined),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });
  }
}
