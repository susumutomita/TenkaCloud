import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

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
 * [Issue #2674] 旧 GSI2 (`TEAMKEY#<平文キー>` で 1 行引く sparse index) は削除済み。
 * participant の teamLoginKey 認証は Deployments テーブルの GSI2 が正本で、
 * Teams 側の index は読み手ゼロのまま平文 bearer を保持し続けていたため落とした。
 * 平文 `teamLoginKey` 属性そのものは残る (bulk-deploy への credential 供給と
 * 運営のキー再配布が読む)。
 *
 * Capacity / lifecycle:
 *   provisioned 1/1。RETAIN (operator が後で参照したい場合のため)。
 */
export class TeamsTable extends Construct {
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
