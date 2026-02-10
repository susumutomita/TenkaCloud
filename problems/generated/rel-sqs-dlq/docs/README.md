# SQS デッドレターキューによるメッセージ信頼性確保

## 概要

SQS キューとデッドレターキューを構成し、処理失敗メッセージの安全な隔離と再処理を実現する構築型問題です。

## 対象サービス

- Amazon SQS

## 信頼性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| メインキュー | SQS 標準キュー + メッセージ保持期間 | 25 点 |
| デッドレターキュー | 失敗メッセージ格納用 DLQ | 25 点 |
| リドライブポリシー | 最大受信回数 3 回のリドライブポリシー | 30 点 |
| 暗号化 | 両キューの SSE-SQS 暗号化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetQueueAttributes` でメインキューが存在し MessageRetentionPeriod が設定されているか
2. `GetQueueAttributes` で DLQ が存在するか
3. `GetQueueAttributes` で RedrivePolicy の maxReceiveCount が 3 であるか
4. `GetQueueAttributes` で両キューの SqsManagedSseEnabled が true であるか

## 参考ドキュメント

- [SQS デッドレターキュー](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [SQS サーバーサイド暗号化](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html)
