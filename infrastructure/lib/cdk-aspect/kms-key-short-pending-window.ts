import type { IAspect } from "aws-cdk-lib";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import type { IConstruct } from "constructs";

/** AWS KMS 削除待機期間の許容範囲 (= AWS 仕様)。 */
export const KMS_PENDING_WINDOW_MIN_DAYS = 7;
export const KMS_PENDING_WINDOW_MAX_DAYS = 30;

/**
 * 全ての KMS Key (`AWS::KMS::Key`) の `PendingWindowInDays` を caller 指定値に揃える Aspect。
 *
 * AWS KMS は key 削除をスケジュールしてから実削除までの待機期間が必須で、許容範囲は
 * 7〜30 日。default 30 日のまま `make destroy` を実行すると、削除予定の key が 30 日間
 * "Pending Deletion" 状態のまま AWS Free Tier 枠 ($1/key/月) を消費し続ける。
 *
 * caller (`bin/infrastructure.ts`) が env / config から値を渡し、stack 横断で適用する。
 * dev / training は最短 7、production は監査要件に応じて伸ばすなど、環境別に調整可能。
 *
 * 対象は CDK / SBT (`@cdklabs/sbt-aws`) が内部的に自動生成する KMS Key (CodeBuild の
 * EncryptionKey 等) を含む全ての `AWS::KMS::Key`。
 *
 * 設計: default 値はコンストラクタに入れない。env 由来の値が来ているかどうかが判別不能
 * になりデバッグ困難になるため、default の決定は単一箇所 (env 読み出し) に閉じる
 * (`DynamoDbLowCapacity` Aspect と同じ方針)。
 */
export class KmsKeyShortPendingWindow implements IAspect {
  constructor(private readonly pendingWindowInDays: number) {
    if (
      !Number.isInteger(pendingWindowInDays) ||
      pendingWindowInDays < KMS_PENDING_WINDOW_MIN_DAYS ||
      pendingWindowInDays > KMS_PENDING_WINDOW_MAX_DAYS
    ) {
      throw new Error(
        `KmsKeyShortPendingWindow: pendingWindowInDays must be an integer in ` +
          `[${KMS_PENDING_WINDOW_MIN_DAYS}, ${KMS_PENDING_WINDOW_MAX_DAYS}] (AWS KMS spec). ` +
          `Got: ${pendingWindowInDays}`,
      );
    }
  }

  public visit(node: IConstruct): void {
    if (!(node instanceof CfnKey)) return;
    node.pendingWindowInDays = this.pendingWindowInDays;
  }
}
