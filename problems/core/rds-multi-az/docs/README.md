# マルチ AZ RDS の高可用性構築

## 概要

RDS MySQL インスタンスを新規作成し、高可用性要件を満たすよう設定する構築型問題です。

## 対象サービス

- Amazon RDS (MySQL)
- Amazon VPC

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| マルチ AZ 配置 | 自動フェイルオーバーが有効な Multi-AZ デプロイメント | 30 点 |
| 自動バックアップ | 保持期間 7 日以上の自動バックアップ | 25 点 |
| ストレージ暗号化 | RDS ストレージ暗号化の有効化 | 20 点 |
| サブネットグループ | 複数 AZ にまたがる DB サブネットグループ | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeDBInstances` で `MultiAZ: true` であるか
2. `DescribeDBInstances` で `BackupRetentionPeriod >= 7` であるか
3. `DescribeDBInstances` で `StorageEncrypted: true` であるか
4. `DescribeDBSubnetGroups` でサブネットが 2 つ以上の AZ に分散しているか

## 参考ドキュメント

- [Amazon RDS マルチ AZ デプロイメント](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)
- [Amazon RDS の自動バックアップ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
- [Amazon RDS の暗号化](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html)
