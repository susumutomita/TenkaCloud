# リソースタグ付けポリシーと自動適用

## 概要

AWS Config を使い、必須タグの適用を監視し未設定リソースを検出・通知する仕組みを構築する構築型問題です。

## 対象サービス

- AWS Config
- Amazon SNS
- Amazon S3

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Config ルール | 必須タグチェック Config ルール | 30 点 |
| SNS 通知 | タグ未設定リソース検出通知 | 25 点 |
| Config レコーダー | AWS Config レコーダーの有効化 | 25 点 |
| S3 バケット | デリバリーチャンネル用 S3 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeConfigRules` で required-tags ルールが存在するか
2. `ListTopics` で SNS トピックが存在するか
3. `DescribeConfigurationRecorders` でレコーダーが存在するか
4. `ListBuckets` でデリバリーチャンネル用 S3 バケットが存在するか

## 参考ドキュメント

- [AWS Config マネージドルール](https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html)
- [タグ付けベストプラクティス](https://docs.aws.amazon.com/tag-editor/latest/userguide/tagging-best-practices.html)
