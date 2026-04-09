# Step Functions ワークフロー設計

## 概要

Step Functions で注文処理ワークフローを構築し、エラーハンドリング、並列処理、通知を設定する構築型問題です。

## 対象サービス

- AWS Step Functions
- AWS Lambda
- Amazon SNS
- CloudWatch Logs

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ステートマシン | 4 ステップ注文処理 | 25 点 |
| エラーハンドリング | Retry + Catch | 25 点 |
| 並列処理 | Parallel ステート | 20 点 |
| 通知 + ログ | SNS + CloudWatch Logs | 30 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeStateMachine` でステートマシンの存在と定義を確認
2. ASL 定義内の Retry/Catch 設定を確認
3. ASL 定義内の Parallel ステートを確認
4. SNS トピックの存在とログ設定を確認

## 参考ドキュメント

- [Step Functions ワークフロー](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-standard-vs-express.html)
- [エラーハンドリング](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
