# Aurora Global Database によるクロスリージョン DR

## 概要

Aurora Global Database を使い、RPO 1 秒以下のクロスリージョンディザスタリカバリ構成を構築する構築型問題です。

## 対象サービス

- Amazon Aurora (MySQL)
- Amazon CloudWatch
- Amazon VPC

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Aurora クラスター | プライマリリージョンの Aurora MySQL クラスター | 25 点 |
| グローバルクラスター | Aurora Global Database の構成 | 25 点 |
| 暗号化 | ストレージ暗号化の有効化 | 15 点 |
| サブネットグループ | マルチ AZ DB サブネットグループ | 15 点 |
| 監視 | Enhanced Monitoring + CloudWatch アラーム | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeDBClusters` で Aurora クラスターが存在するか
2. `DescribeGlobalClusters` でグローバルクラスターが存在するか
3. `DescribeDBClusters` で StorageEncrypted が true であるか
4. `DescribeDBSubnetGroups` でサブネットが 2 つ以上の AZ に分散しているか
5. `DescribeDBInstances` で MonitoringInterval が設定され、CloudWatch アラームが存在するか

## 参考ドキュメント

- [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [Enhanced Monitoring](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_Monitoring.OS.html)
