import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

/**
 * 問題 deploy ジョブを 1 行 1 件で記録する DynamoDB テーブル。
 *
 * Schema:
 *   PK: DEPLOYMENT#<jobId>          (jobId = ULID)
 *   SK: META
 *
 * 主な属性:
 *   jobId / problemId / tenantId / awsAccountId / region / teamName /
 *   namePrefix / teamLoginKey / status / buildId / stackId / stackOutputs /
 *   failureReason / createdAt / updatedAt / expiresAt
 *
 * GSI1 (テナント別の deployment 一覧):
 *   PK: TENANT#<tenantId>
 *   SK: createdAt (ISO8601)
 *
 * GSI2 (sparse, participant portal がチーム共有ログインキーで引く):
 *   PK: TEAMKEY#<teamLoginKey>
 *   SK: createdAt (ISO8601)
 *   GSI2PK 属性が無い行 (= teamLoginKey が無効化された行) はインデックスから自動的に外れる
 *
 * GSI3 (sparse, Composite Runtime #2061 — 親 deployment から target 行を引く):
 *   PK: PARENT_DEPLOYMENT#<parentDeploymentId>
 *   SK: ORDINAL#<zero-padded ordinal>#TARGET#<targetId> (target 宣言順で並ぶ)
 *   target 行だけが GSI3PK / GSI3SK を持つ。 legacy 行と composite parent 行は持たない
 *   ため、 既存の tenant 一覧 (GSI1) / participant 一覧 (GSI2) には現れない
 *
 * memory: provisioned 1/1 (DynamoDbLowCapacity Aspect で更に均す)。training / 競技
 * イベント中の用途で QPS 極小、コスト 0 原則を優先する。
 *
 * 削除方針: 既定 DESTROY (#2959)。`CDK_PARAM_RETAIN_DATA_TABLES=true` のときだけ RETAIN。
 * 消し忘れた table が PROVISIONED 容量で課金され続けるほうが実害が大きい、という判断による。
 * 必要なら手動で破棄する。
 */
export class DeploymentsTable extends Construct {
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

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });

    // [Composite Runtime #2061] Parent → target lookup. Sparse: only composite
    // target rows set GSI3PK / GSI3SK, so legacy + composite parent rows stay
    // out of this index. Same provisioned 1/1 budget as GSI1 / GSI2.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI3",
      partitionKey: { name: "GSI3PK", type: AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });
  }
}
