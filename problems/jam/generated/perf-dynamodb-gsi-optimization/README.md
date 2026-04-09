# DynamoDB グローバルセカンダリインデックスの最適設計

## 概要

DynamoDB テーブルに GSI を追加してクエリパフォーマンスを改善する構築型問題です。

## 対象サービス

- Amazon DynamoDB

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| メインテーブル | userId + orderId キー設計 | 25 点 |
| ステータス GSI | status + createdAt インデックス | 30 点 |
| 投影設定 | INCLUDE (amount, itemCount) | 25 点 |
| オンデマンドモード | PAY_PER_REQUEST | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeTable` で KeySchema が userId (HASH) + orderId (RANGE) であるか
2. `DescribeTable` の GSI に status (HASH) + createdAt (RANGE) が存在するか
3. GSI の Projection で INCLUDE かつ NonKeyAttributes に amount, itemCount が含まれるか
4. `DescribeTable` で BillingMode が PAY_PER_REQUEST であるか

## 参考ドキュメント

- [DynamoDB GSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [DynamoDB 投影](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html#GSI.Projections)
