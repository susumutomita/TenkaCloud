# SNS マルチチャネル通知とフィルタリング

## 概要

SNS のフィルタポリシーを使い、障害レベルに応じて複数チャネル（メール、Lambda、SQS）に通知を振り分ける構築型問題です。

## 対象サービス

- Amazon SNS
- AWS Lambda
- Amazon SQS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| SNS トピック | 運用イベント通知用トピック | 25 点 |
| メールサブスクリプション | 全レベルメール通知 | 25 点 |
| Lambda サブスクリプション | CRITICAL フィルタ + Lambda | 25 点 |
| SQS サブスクリプション | INFO フィルタ + SQS アーカイブ | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListTopics` で SNS トピックが存在するか
2. `ListSubscriptionsByTopic` でメールサブスクリプションが存在するか
3. `GetSubscriptionAttributes` で Lambda サブスクリプションに CRITICAL フィルタが設定されているか
4. `GetSubscriptionAttributes` で SQS サブスクリプションに INFO フィルタが設定されているか

## 参考ドキュメント

- [SNS サブスクリプションフィルタ](https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html)
- [SNS マルチチャネル通知](https://docs.aws.amazon.com/sns/latest/dg/sns-fanout.html)
