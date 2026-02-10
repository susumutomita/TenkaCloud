# DynamoDB グローバルテーブルによるマルチリージョン構成

## 概要

DynamoDB グローバルテーブルを使い、マルチリージョンで高可用性・低レイテンシーなデータストアを構築する構築型問題です。

## 対象サービス

- Amazon DynamoDB

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| テーブル作成 | PK + SK を持つ DynamoDB テーブル | 25 点 |
| レプリカ設定 | 別リージョンへのレプリカ構成 | 30 点 |
| オンデマンドキャパシティ | PAY_PER_REQUEST モード | 20 点 |
| ポイントインタイムリカバリ | PITR の有効化 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeTable` でテーブルが存在し、PK/SK キースキーマが正しいか
2. `DescribeGlobalTable` でレプリカが別リージョンに存在するか
3. `DescribeTable` で BillingMode が PAY_PER_REQUEST であるか
4. `DescribeContinuousBackups` で PITR が有効化されているか

## 参考ドキュメント

- [DynamoDB グローバルテーブル](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [ポイントインタイムリカバリ](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery.html)
