# Lambda デッドレターキューとリトライ構成

## 概要

Lambda 関数の障害時にメッセージが失われない仕組みを DLQ とリトライ設定で構築する構築型問題です。

## 対象サービス

- AWS Lambda
- Amazon SQS
- AWS IAM

## 信頼性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Lambda 関数 | SQS トリガーの Lambda 関数 | 20 点 |
| ソースキューと DLQ | リドライブポリシーで接続されたキュー | 25 点 |
| イベントソースマッピング | Lambda-SQS イベントソースマッピング | 20 点 |
| Lambda 送信先 | 非同期呼び出し失敗時の送信先 | 15 点 |
| IAM ロール | Lambda 実行用 IAM ロール | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetFunction` で Lambda 関数が存在するか
2. `GetQueueAttributes` で SourceQueue と DLQ がリドライブポリシーで接続されているか
3. `ListEventSourceMappings` でイベントソースマッピングが存在するか
4. `GetFunctionEventInvokeConfig` で失敗時送信先が設定されているか
5. `GetRole` で IAM ロールが SQS 読み取りと Lambda 実行の権限を持つか

## 参考ドキュメント

- [Lambda デッドレターキュー](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html)
- [Lambda イベントソースマッピング](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
