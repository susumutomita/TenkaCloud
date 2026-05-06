import type { IAspect } from "aws-cdk-lib";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import type { IConstruct } from "constructs";

/**
 * 全ての KMS Key (`AWS::KMS::Key`) の `PendingWindowInDays` を 7 に揃える Aspect。
 *
 * AWS KMS は key 削除をスケジュールしてから実削除までの待機期間が必須で、許容範囲は
 * 7〜30 日。default 30 日のまま `make destroy` を実行すると、削除予定の key が 30 日間
 * "Pending Deletion" 状態のまま AWS Free Tier 枠 ($1/key/月) を消費し続ける。
 *
 * 待機期間を最短 7 日に短縮することで、誤削除時の rollback 余地を残しつつ teardown 後の
 * 課金期間を縮める。training / demo 用途の TenkaCloud では誤削除しても再 deploy で
 * 復旧可能なため 7 日で十分。
 *
 * 対象は CDK / SBT (`@cdklabs/sbt-aws`) が内部的に自動生成する KMS Key (CodeBuild の
 * EncryptionKey 等) を含む全ての `AWS::KMS::Key`。
 */
export class KmsKeyShortPendingWindow implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnKey)) return;
    node.pendingWindowInDays = 7;
  }
}
