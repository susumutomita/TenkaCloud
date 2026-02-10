# リアルタイムストリーミングデータパイプラインの最適化

## 概要

Kinesis -> Lambda -> DynamoDB のストリーミングパイプラインを最適化し、高スループット低レイテンシの処理を実現する Expert 問題です。

## 対象サービス

- Amazon Kinesis Data Streams
- AWS Lambda
- Amazon DynamoDB

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Kinesis Stream | オンデマンドモード | 15 点 |
| Lambda イベントソース最適化 | Batch 100、Window 5s、Parallel 10 | 30 点 |
| Lambda 関数 | arm64、512 MB、60s | 15 点 |
| DynamoDB テーブル | オンデマンド + TTL | 15 点 |
| エラーハンドリング | Bisect + Retry 3 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeStreamSummary` で StreamMode が ON_DEMAND であるか
2. `GetEventSourceMapping` で BatchSize=100、Window=5、ParallelizationFactor=10 であるか
3. `GetFunctionConfiguration` で arm64、512 MB、Timeout 60 であるか
4. `DescribeTable` で PAY_PER_REQUEST かつ TTL 有効であるか
5. `GetEventSourceMapping` で BisectBatchOnFunctionError=true、MaximumRetryAttempts=3 であるか

## 参考ドキュメント

- [Lambda Kinesis イベントソース](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html)
- [Lambda ParallelizationFactor](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html#services-kinesis-params)
