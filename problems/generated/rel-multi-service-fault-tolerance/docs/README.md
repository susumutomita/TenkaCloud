# 複合サービス耐障害性アーキテクチャ

## 概要

API Gateway、Step Functions、Lambda、SQS、DynamoDB を組み合わせ、サーキットブレーカーパターンを実装した耐障害性アーキテクチャを構築する Expert レベルの構築型問題です。

## 対象サービス

- Amazon API Gateway
- AWS Step Functions
- AWS Lambda
- Amazon SQS
- Amazon DynamoDB
- Amazon SNS

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| API Gateway | REST API エンドポイント | 15 点 |
| Step Functions | リトライ/キャッチ付きステートマシン | 25 点 |
| Lambda 関数群 | 処理用 + フォールバック用 | 20 点 |
| SQS バッファ | 過負荷時バッファキュー | 15 点 |
| DynamoDB | サーキットブレーカー状態テーブル | 15 点 |
| SNS 通知 | CB 開放時通知 | 10 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetRestApis` で API Gateway が存在するか
2. `DescribeStateMachine` で Retry/Catch が定義されたステートマシンが存在するか
3. `ListFunctions` で処理用・フォールバック用 Lambda が存在するか
4. `GetQueueAttributes` で SQS バッファキューが存在するか
5. `DescribeTable` でサーキットブレーカーテーブルが存在するか
6. `ListTopics` で SNS トピックが存在するか

## 参考ドキュメント

- [Step Functions エラーハンドリング](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
- [サーキットブレーカーパターン](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html)
