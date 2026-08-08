import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

/**
 * Issue #888: Red Team Disruption Injection の audit log を保存する DynamoDB テーブル。
 *
 * Schema:
 *   PK: EVENT#<eventId>            tenantId / eventId は GSI1PK で参照する
 *   SK: AUDIT#<firedAt>#<auditId>  ULID で append-only
 *
 * 主な属性:
 *   auditId / tenantId / eventId / problemId / disruptionId / firedBy (= Cognito sub)
 *   / firedAt (ISO8601) / scope / targetTeamIds[] / parameters / requestId / expiresAt
 *
 * GSI1 (= requestId Idempotency lookup):
 *   PK: REQUEST#<requestId>
 *   SK: METADATA  (1 requestId につき 1 row)
 *
 * Capacity / lifecycle:
 *   provisioned 1/1 (DynamoDbLowCapacity Aspect が均す)。 audit 用途で QPS 極小、
 *   Free Tier 内に収める。
 *   削除方針: 既定 DESTROY (#2959)。`CDK_PARAM_RETAIN_DATA_TABLES=true` のときだけ RETAIN。
 * 消し忘れた table が PROVISIONED 容量で課金され続けるほうが実害が大きい、という判断による。
 *   TTL は expiresAt 属性で 7 日 (operator が長期保管したい場合は exporter で別 sink へ)。
 */
export class DisruptionsTable extends Construct {
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
      timeToLiveAttribute: "expiresAt",
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });
  }
}
