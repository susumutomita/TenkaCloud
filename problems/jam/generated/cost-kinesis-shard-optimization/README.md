# Kinesis Data Streams のシャードとモード最適化

## 概要

Kinesis Data Streams をプロビジョンドからオンデマンドモードに移行し、Firehose で S3 に配信するパイプラインを構築してコストを削減する問題です。

## 対象サービス

- Amazon Kinesis Data Streams
- Amazon Kinesis Data Firehose
- Amazon S3

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| オンデマンドモード | ON_DEMAND に設定 | 30 点 |
| 暗号化 | KMS ストリーム暗号化 | 20 点 |
| Firehose 配信 | S3 への配信構成 | 25 点 |
| S3 バッファリング | 5 MB / 300 秒 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeStreamSummary` で StreamMode が ON_DEMAND であるか
2. `DescribeStreamSummary` で EncryptionType が KMS であるか
3. `DescribeDeliveryStream` で S3 配信構成が存在するか
4. `DescribeDeliveryStream` で BufferingHints が SizeInMBs=5, IntervalInSeconds=300 であるか

## 参考ドキュメント

- [Kinesis Data Streams オンデマンドモード](https://docs.aws.amazon.com/streams/latest/dev/how-do-i-size-a-stream.html)
- [Kinesis Data Firehose](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
