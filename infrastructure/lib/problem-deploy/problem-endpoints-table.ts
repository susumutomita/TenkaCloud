import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * ADR-012 Phase 3.A: Endpoint registry の per (tenant, team, problem, slot) 行を 1 行に
 * 記録する DynamoDB テーブル。
 *
 * Schema:
 *   PK: TENANT#<tenantId>#TEAM#<teamId>#PROBLEM#<problemId>
 *   SK: SLOT#<slotName>
 *
 * 主な属性:
 *   overrideUrl    競技者が portal で上書きした URL (= absent なら default 採用)
 *   platform       過去 probe で観測した platform 識別子 (Phase 3.B 以降で /meta から抽出)
 *   defaultCacheUrl 直近 deploy 完了時に CFn output から算出した default のキャッシュ
 *                  (任意、Phase 3.A は read-through 算出なので必須ではない)
 *   updatedAt      ISO 8601
 *
 * Phase 3.A では override のみを永続化し、default URL は read-through で stackOutputs +
 * problem metadata から算出する。Phase 3.B 以降で deploy 完了 hook (= Step Function 経由)
 * を足して default も per-team で永続化する余地を残す。
 *
 * memory: provisioned 1/1 (DynamoDbLowCapacity Aspect で再均し)。override の write 頻度は
 * 競技者 1 人 1 回 / 競技中 (= 極小)、GET は per-page-load (= 数 RCU/s) 想定。
 *
 * 削除方針: RETAIN。competitor の override 履歴を stack delete で意図せず消さない。
 */
export class ProblemEndpointsTable extends Construct {
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

/** PK 構築 helper — runtime / test で同一規約を保つ。 */
export function buildEndpointPK(tenantId: string, teamId: string, problemId: string): string {
  return `TENANT#${tenantId}#TEAM#${teamId}#PROBLEM#${problemId}`;
}

/** SK 構築 helper — slot 名 (kebab-case) は metadata 側で validation 済前提。 */
export function buildEndpointSK(slot: string): string {
  return `SLOT#${slot}`;
}
