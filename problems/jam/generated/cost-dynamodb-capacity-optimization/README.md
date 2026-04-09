# DynamoDB キャパシティモードとインデックス最適化

## 概要

DynamoDB テーブルのキャパシティモード、TTL、暗号化を最適化してコストを削減する構築型問題です。

## 対象サービス

- Amazon DynamoDB

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| オンデマンドモード | PAY_PER_REQUEST に設定 | 30 点 |
| TTL 有効化 | expiresAt 属性で TTL を有効化 | 30 点 |
| テーブル暗号化 | SSE を有効化 | 20 点 |
| ポイントインタイムリカバリ | PITR を有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeTable` で BillingMode が PAY_PER_REQUEST であるか
2. `DescribeTimeToLive` で TTL が有効で AttributeName が expiresAt であるか
3. `DescribeTable` で SSEDescription が ENABLED であるか
4. `DescribeContinuousBackups` で PointInTimeRecoveryStatus が ENABLED であるか

## 参考ドキュメント

- [DynamoDB オンデマンドキャパシティ](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadWriteCapacityMode.html)
- [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
