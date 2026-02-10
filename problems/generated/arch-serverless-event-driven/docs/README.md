# サーバーレス イベント駆動アーキテクチャ

## 概要

EventBridge、SNS、SQS、Lambda、DynamoDB を組み合わせた完全サーバーレスのイベント駆動アーキテクチャを構築する構築型問題です。

## 対象サービス

- Amazon EventBridge
- Amazon SNS
- Amazon SQS
- AWS Lambda
- Amazon DynamoDB

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EventBridge | カスタムバス + ルール | 15 点 |
| SNS ファンアウト | 複数 SQS サブスクリプション | 20 点 |
| SQS + Lambda | イベントソースマッピング | 20 点 |
| DynamoDB + Streams | テーブル + Streams 有効 | 20 点 |
| DLQ + エラー処理 | 全キューに DLQ | 15 点 |
| 同時実行制御 | ReservedConcurrentExecutions | 10 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeEventBus` と `ListRules` で EventBridge 構成を確認
2. `ListSubscriptionsByTopic` で SNS サブスクリプションを確認
3. `ListEventSourceMappings` で SQS-Lambda 接続を確認
4. `DescribeTable` で DynamoDB 設定と Streams を確認
5. `GetQueueAttributes(RedrivePolicy)` で DLQ 設定を確認
6. `GetFunction` で ReservedConcurrentExecutions を確認

## 参考ドキュメント

- [EventBridge イベントバス](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html)
- [SNS ファンアウトパターン](https://docs.aws.amazon.com/sns/latest/dg/sns-common-scenarios.html)
