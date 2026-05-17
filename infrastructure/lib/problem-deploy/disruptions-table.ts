import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

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
 *   Free Tier 内に収める。 削除方針: RETAIN (= stack 削除で history を失わない)。
 *   TTL は expiresAt 属性で 7 日 (operator が長期保管したい場合は exporter で別 sink へ)。
 */
export class DisruptionsTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: RemovalPolicy.RETAIN,
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
