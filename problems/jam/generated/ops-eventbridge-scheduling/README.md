# EventBridge スケジュールによる運用タスク自動化

## 概要

EventBridge スケジュールルールと Lambda を使い、定期的な運用タスクを自動化する構築型問題です。

## 対象サービス

- Amazon EventBridge
- AWS Lambda
- Amazon SQS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| スケジュールルール | 毎日 UTC 15:00 の EventBridge ルール | 30 点 |
| Lambda 関数 | スケジュール起動の Lambda | 30 点 |
| IAM ロール | Lambda 実行用 IAM ロール | 20 点 |
| DLQ | 実行失敗時の DLQ | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListRules` でスケジュールルールが存在し cron 式が正しいか
2. `GetFunction` で Lambda 関数が存在するか
3. `GetRole` で IAM ロールが存在するか
4. `GetFunction` で DeadLetterConfig が設定されているか

## 参考ドキュメント

- [EventBridge スケジュールルール](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)
- [Lambda DLQ](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html)
