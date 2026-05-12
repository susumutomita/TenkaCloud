import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Microservice Migration Battle (Phase 2 / Issue #606) の登録 endpoint + 観測結果テーブル。
 *
 * Schema:
 *   PK: TENANT#<tenantId>#PROBLEM#microservice-migration-battle
 *   SK: SLOT#<users|orders|catalog>
 *
 * 主な属性 (詳細は `handlers/microservice-migration-registration-handler/types.ts`):
 *   - 登録 (registration handler 専管): tenantId / problemId / slot / registeredUrl /
 *     registeredAt / registeredBy
 *   - 観測 (polling Lambda 専管): platform / lastProbeAt / lastResult / lastPoints /
 *     lastResponseTimeMs
 *   - lump-sum bonus sentinel (1 tenant につき users slot の row に立てる):
 *     fullMigrationBonusAwarded
 *
 * GSI 無し: tenant 内 1 Query で全 slot を取れる (PK 単一)。
 *
 * Capacity / lifecycle:
 *   PROVISIONED 1/1 (`DynamoDbLowCapacity` Aspect で更に均す)。1 min polling × 最大
 *   ~10 tenant × 3 slot = 1 invocation あたり ~30 row read で十分。RETAIN — 競技中
 *   stack delete でも登録履歴は残す。
 */
export class MicroserviceMigrationScoresTable extends Construct {
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
    });
  }
}
