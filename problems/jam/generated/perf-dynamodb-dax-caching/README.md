# DynamoDB DAX クラスターによるマイクロ秒レイテンシ

## 概要

DynamoDB DAX クラスターを構成してマイクロ秒レベルの読み取りレイテンシを実現する構築型問題です。

## 対象サービス

- Amazon DynamoDB
- Amazon DynamoDB Accelerator (DAX)

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| DAX クラスター | dax.r5.large 2 ノード | 30 点 |
| 暗号化 | SSE 有効 | 20 点 |
| パラメータグループ | TTL 300000ms | 25 点 |
| DynamoDB テーブル | オンデマンドモード | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeClusters` で NodeType が dax.r5.large、ノード数が 2 であるか
2. `DescribeClusters` で SSEDescription が ENABLED であるか
3. `DescribeParameterGroups` で TTL が 300000 であるか
4. `DescribeTable` で BillingMode が PAY_PER_REQUEST であるか

## 参考ドキュメント

- [DynamoDB DAX](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DAX.html)
- [DAX クラスター構成](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DAX.cluster-management.html)
