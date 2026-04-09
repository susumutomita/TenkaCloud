# S3 バケットのセキュア構築

## 概要

S3 バケットを新規作成し、組織のセキュリティ基準を満たすよう設定する構築型問題です。

## 対象サービス

- Amazon S3

## セキュリティ要件

| 要件 | 内容 | 配点 |
|------|------|------|
| サーバーサイド暗号化 | SSE-S3（AES-256）によるデフォルト暗号化 | 30 点 |
| パブリックアクセスブロック | 4 項目すべて有効 | 30 点 |
| バージョニング | バケットバージョニング有効 | 20 点 |
| アクセスログ | サーバーアクセスログの出力設定 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetBucketEncryption` で SSE-S3 が設定されているか
2. `GetPublicAccessBlock` で 4 項目がすべて `true` か
3. `GetBucketVersioning` で `Status: Enabled` か
4. `GetBucketLogging` でログ出力先が設定されているか

## 参考ドキュメント

- [Amazon S3 のセキュリティベストプラクティス](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [S3 のデフォルト暗号化](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-encryption.html)
- [S3 パブリックアクセスのブロック](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
