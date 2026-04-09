# セキュリティイベント集約パイプライン（SIEM）

## 概要

Security Hub、CloudTrail、EventBridge、Kinesis Firehose を組み合わせたセキュリティイベント集約パイプラインを構築する構築型問題です。

## 対象サービス

- AWS Security Hub
- AWS CloudTrail
- Amazon EventBridge
- Amazon Kinesis Data Firehose
- Amazon S3
- Amazon SNS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Security Hub | 有効化 + ベストプラクティス | 15 点 |
| CloudTrail | 全イベント記録 | 15 点 |
| EventBridge | セキュリティイベント集約 | 20 点 |
| Firehose | S3 配信パイプライン | 20 点 |
| S3 データレイク | 暗号化 + ライフサイクル | 15 点 |
| Critical アラート | SNS 通知 | 15 点 |

## 参考ドキュメント

- [Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/what-is-securityhub.html)
- [CloudTrail データイベント](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html)
