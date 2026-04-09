# データレイク多層ストレージとクエリコスト最適化

## 概要

S3 Intelligent-Tiering、Glue パーティション分割テーブル、Athena ワークグループを組み合わせてデータレイクのストレージとクエリコストを最適化する Expert 問題です。

## 対象サービス

- Amazon S3 (Intelligent-Tiering)
- AWS Glue Data Catalog
- Amazon Athena

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| S3 Intelligent-Tiering | アーカイブ 90 日 + ディープアーカイブ 180 日 | 25 点 |
| Glue パーティションテーブル | year/month/day パーティション | 25 点 |
| Athena ワークグループ | スキャン上限 1 GB | 20 点 |
| Athena 結果暗号化 | 結果の SSE-S3 暗号化 | 15 点 |
| ライフサイクルルール | 365 日後に Glacier Deep Archive | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetBucketIntelligentTieringConfiguration` でアーカイブ層が設定されているか
2. `GetTable` で PartitionKeys に year/month/day が含まれるか
3. `GetWorkGroup` で BytesScannedCutoffPerQuery が 1073741824 であるか
4. `GetWorkGroup` の ResultConfiguration に EncryptionConfiguration が設定されているか
5. `GetBucketLifecycleConfiguration` で Glacier Deep Archive 移行ルールがあるか

## 参考ドキュメント

- [S3 Intelligent-Tiering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering.html)
- [Athena パーティション](https://docs.aws.amazon.com/athena/latest/ug/partitions.html)
- [Athena ワークグループ](https://docs.aws.amazon.com/athena/latest/ug/workgroups.html)
