# S3 ライフサイクルポリシーによるコスト最適化

## 概要

S3 バケットにライフサイクルポリシーを設定し、ストレージコストを最適化する構築型問題です。

## 対象サービス

- Amazon S3

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Standard-IA 移行 | 30 日後に STANDARD_IA へ移行 | 25 点 |
| Glacier IR 移行 | 90 日後に GLACIER_IR へ移行 | 25 点 |
| オブジェクト有効期限 | 365 日後に自動削除 | 25 点 |
| マルチパートアップロード削除 | 7 日以上の不完全アップロードを削除 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetBucketLifecycleConfiguration` で STANDARD_IA への 30 日移行ルールがあるか
2. `GetBucketLifecycleConfiguration` で GLACIER_IR への 90 日移行ルールがあるか
3. ライフサイクルルールに `ExpirationInDays: 365` が設定されているか
4. `AbortIncompleteMultipartUpload` に `DaysAfterInitiation: 7` が設定されているか

## 参考ドキュメント

- [S3 ライフサイクルの管理](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [S3 ストレージクラス](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)
- [不完全なマルチパートアップロードの管理](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
