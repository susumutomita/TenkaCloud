import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

/**
 * 1 競技イベント (1 Event) を 1 行で記録する DynamoDB テーブル。
 *
 * Schema:
 *   PK: EVENT#<eventId>     (eventId = ULID)
 *   SK: META
 *
 * 主な属性:
 *   eventId / tenantId / name / status / problems[] / createdAt / updatedAt / expiresAt
 *
 * `problems[]` は { problemId, defaultAwsAccountId, defaultRegion } の配列で、
 * Bulk Deploy 時に各 team × problem の deploy target を解決するのに使う。
 *
 * GSI1 (テナント別の event 一覧):
 *   PK: TENANT#<tenantId>
 *   SK: createdAt (ISO8601)
 *
 * Capacity / lifecycle:
 *   provisioned 1/1 (DynamoDbLowCapacity Aspect でさらに均す)。training / 競技イベント
 *   中の用途で QPS 極小、コスト 0 原則を優先する。
 *   削除方針: 既定 DESTROY (#2959)。`CDK_PARAM_RETAIN_DATA_TABLES=true` のときだけ RETAIN。
 *   消し忘れた table が PROVISIONED 容量で課金され続けるほうが実害が大きい、という判断による。
 */
export class EventsTable extends Construct {
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
