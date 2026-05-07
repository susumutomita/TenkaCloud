import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * 1 競技イベントに参加する 1 チームを 1 行で記録する DynamoDB テーブル (ADR-004 Phase 1)。
 *
 * Schema:
 *   PK: EVENT#<eventId>
 *   SK: TEAM#<teamId>     (teamId = ULID)
 *
 * 主な属性:
 *   eventId / teamId / tenantId / displayName? / internalSlug / teamLoginKey /
 *   createdAt / updatedAt / expiresAt
 *
 * `teamLoginKey` は **team scope の短命 bearer**。1 team = 1 key で event 内の N 問題の
 * Participant Portal アクセスを共通化する (ADR-004 §3)。
 *
 * GSI1 (テナント横断で全 team を引く / event 横断):
 *   PK: TENANT#<tenantId>
 *   SK: EVENT#<eventId>#TEAM#<teamId>
 *
 * GSI2 (Participant Portal が teamLoginKey で 1 行引く):
 *   PK: TEAMKEY#<teamLoginKey>
 *   SK: META
 *   sparse — 失効した team は GSI2PK 属性ごと削除して index から外す
 *
 * Capacity / lifecycle:
 *   provisioned 1/1。RETAIN (operator が後で参照したい場合のため)。
 */
export class TeamsTable extends Construct {
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

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });
  }
}
