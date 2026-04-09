# SQS バッチ処理とデッドレターキューの最適化

## 概要

SQS キューのバッチ処理設定と DLQ を構成してメッセージ処理のスループットを改善する構築型問題です。

## 対象サービス

- Amazon SQS
- AWS Lambda

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| バッチサイズ | BatchSize 10 | 30 点 |
| DLQ 設定 | maxReceiveCount 3 | 30 点 |
| 可視性タイムアウト | 300 秒 | 20 点 |
| 暗号化 | SQS マネージド SSE | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `ListEventSourceMappings` で BatchSize が 10 であるか
2. `GetQueueAttributes` で RedrivePolicy の maxReceiveCount が 3 であるか
3. `GetQueueAttributes` で VisibilityTimeout が 300 であるか
4. `GetQueueAttributes` で SqsManagedSseEnabled が true であるか

## 参考ドキュメント

- [SQS バッチ処理](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [SQS デッドレターキュー](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
