import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Issue #1973: endpoint-eval の run / evaluation を 1 テーブルに記録する DynamoDB テーブル。
 *
 * Schema (single-table 風だが本テーブル内のみ):
 *   PK: RUN#<runId>
 *   SK: META              — run 本体 (challengeId / seed / createdAt)
 *   SK: EVAL#<evalId>     — 1 回の評価結果 (status / result / clearCode)
 *   SK: PASS#<stageId>    — 合格 stage への冪等ポインタ (= クリアコード再発行の冪等化、 GetItem 1 発)
 *
 * Capacity / lifecycle:
 *   provisioned 1/1 (DynamoDbLowCapacity Aspect でさらに均す、 コスト 0 原則)。
 *   無料・短命の体験用途なので TTL (`expiresAt`、 epoch 秒) で自動削除。
 *   削除方針: DESTROY。 体験データは保持不要 (= stack 削除でテーブルごと消えてよい)。
 */
export class EvalRunsTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      timeToLiveAttribute: "expiresAt",
    });
  }
}
