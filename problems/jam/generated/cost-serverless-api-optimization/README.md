# サーバーレス API 全体のコスト最適化

## 概要

HTTP API、Lambda (arm64)、DynamoDB (オンデマンド)、SQS (ロングポーリング) を組み合わせたサーバーレスアーキテクチャ全体のコストを最適化する Expert 問題です。

## 対象サービス

- Amazon API Gateway (HTTP API)
- AWS Lambda
- Amazon DynamoDB
- Amazon SQS

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| HTTP API | API Gateway V2 (HTTP API) | 20 点 |
| Lambda 最適化 | arm64、128 MB、10 秒 | 25 点 |
| DynamoDB オンデマンド | PAY_PER_REQUEST + TTL | 20 点 |
| SQS ロングポーリング | 20 秒ポーリング | 20 点 |
| ログ保持期間 | 14 日 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetApi` で ProtocolType が HTTP であるか
2. `GetFunctionConfiguration` で arm64、128 MB、Timeout 10 であるか
3. `DescribeTable` で PAY_PER_REQUEST、TTL 有効であるか
4. `GetQueueAttributes` で ReceiveMessageWaitTimeSeconds が 20 であるか
5. `DescribeLogGroups` で RetentionInDays が 14 であるか

## 参考ドキュメント

- [API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)
- [SQS ロングポーリング](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html)
