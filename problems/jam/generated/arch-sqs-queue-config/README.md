# SQS キュー設計（Standard + DLQ）

## 概要

SQS Standard キューとデッドレターキューを構築し、リドライブポリシーとアクセス制御を設定する構築型問題です。

## 対象サービス

- Amazon SQS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| メインキュー | Standard + SSE-SQS 暗号化 | 30 点 |
| DLQ | デッドレターキュー作成 | 20 点 |
| リドライブポリシー | maxReceiveCount: 3 | 25 点 |
| アクセスポリシー | 特定ロールのみ許可 | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `GetQueueAttributes` で暗号化設定を確認
2. DLQ の存在と暗号化を確認
3. `RedrivePolicy` の設定を確認
4. `GetQueueAttributes(Policy)` でアクセスポリシーを確認

## 参考ドキュメント

- [Amazon SQS デッドレターキュー](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [SQS のサーバーサイド暗号化](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html)
