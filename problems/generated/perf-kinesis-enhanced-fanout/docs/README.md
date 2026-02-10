# Kinesis Enhanced Fan-Out による低レイテンシストリーム処理

## 概要

Kinesis Data Streams に Enhanced Fan-Out コンシューマーを設定して低レイテンシのストリーム処理を実現する構築型問題です。

## 対象サービス

- Amazon Kinesis Data Streams

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Kinesis Stream | 4 シャード | 25 点 |
| EFO コンシューマー | 2 つの EFO コンシューマー | 30 点 |
| ストリーム暗号化 | KMS 暗号化 | 20 点 |
| 保持期間 | 168 時間（7 日） | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeStreamSummary` で ShardCount が 4 であるか
2. `ListStreamConsumers` で 2 つの EFO コンシューマーが登録されているか
3. `DescribeStreamSummary` で EncryptionType が KMS であるか
4. `DescribeStreamSummary` で RetentionPeriodHours が 168 であるか

## 参考ドキュメント

- [Kinesis Enhanced Fan-Out](https://docs.aws.amazon.com/streams/latest/dev/enhanced-consumers.html)
- [Kinesis データ保持期間](https://docs.aws.amazon.com/streams/latest/dev/kinesis-extended-retention.html)
