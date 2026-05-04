import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * 問題 deploy ジョブを 1 行 1 件で記録する DynamoDB テーブル。
 *
 * Schema:
 *   PK: DEPLOYMENT#<jobId>          (jobId = ULID)
 *   SK: META
 *
 * 主な属性:
 *   jobId / problemId / tenantId / awsAccountId / region / teamName /
 *   namePrefix / teamLoginKey / status / stackId / stackOutputs /
 *   failureReason / createdAt / updatedAt / expiresAt
 *
 * GSI1 (テナント別の deployment 一覧):
 *   PK: TENANT#<tenantId>
 *   SK: createdAt (ISO8601)
 *
 * memory: provisioned 1/1 (DynamoDbLowCapacity Aspect で更に均す)。training / 競技
 * イベント中の用途で QPS 極小、コスト 0 原則を優先する。
 *
 * 削除方針: RETAIN。stack delete でユーザの deployment 履歴を意図せず消さない。
 * 必要なら手動で破棄する。
 */
export class DeploymentsTable extends Construct {
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
