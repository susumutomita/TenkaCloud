import type { IAspect } from "aws-cdk-lib";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import type { IConstruct } from "constructs";

/**
 * 全ての DynamoDB Table の provisioned throughput を強制的に低 capacity に揃える Aspect。
 *
 * 用途: SBT (\`@cdklabs/sbt-aws\`) などの third-party 構築物が内部で作る Table が
 * billingMode を未指定で PROVISIONED デフォルトの 5/5 になり、Free Tier
 * (25 RCU + 25 WCU per account) を圧迫してコスト発生する問題を回避する。
 *
 * 対象:
 *   - billingMode が未指定 / PROVISIONED の Table のみ (PAY_PER_REQUEST には触らない)
 *   - GSI / LSI の throughput も同じ値で上書き
 *
 * 設計: capacity は **必ず caller (bin/infrastructure.ts) から渡す**。Aspect に
 * `= 1` のような TS default を入れると、env 由来の値が来ているかどうかが判別不能
 * になりデバッグ困難。default 値の決定は単一箇所 (env 読み出し) に閉じる。
 *
 * memory: コスト 0 原則。training/demo 用途で QPS 極小のテーブルは 1/1 で十分。
 */
export class DynamoDbLowCapacity implements IAspect {
  constructor(
    private readonly readCapacity: number,
    private readonly writeCapacity: number,
  ) {}

  public visit(node: IConstruct): void {
    if (!(node instanceof CfnTable)) return;

    // PAY_PER_REQUEST (on-demand) のテーブルは throughput を持たないので触らない
    if (node.billingMode === "PAY_PER_REQUEST") return;

    const throughput = {
      readCapacityUnits: this.readCapacity,
      writeCapacityUnits: this.writeCapacity,
    };

    node.provisionedThroughput = throughput;

    // GSI: CfnTable.globalSecondaryIndexes は IResolvable | Array のいずれもありうる。
    // 配列の場合のみ provisioned throughput を上書き (token / IResolvable には触らない)。
    const gsi = node.globalSecondaryIndexes;
    if (Array.isArray(gsi)) {
      node.globalSecondaryIndexes = gsi.map((index) => {
        if (index && typeof index === "object" && "indexName" in index) {
          return {
            ...(index as CfnTable.GlobalSecondaryIndexProperty),
            provisionedThroughput: throughput,
          };
        }
        return index;
      });
    }
  }
}
