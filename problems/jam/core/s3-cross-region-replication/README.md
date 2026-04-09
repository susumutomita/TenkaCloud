# S3 クロスリージョンレプリケーション構築

## 概要

S3 クロスリージョンレプリケーション（CRR）を構成し、災害復旧要件を満たす構築型問題です。

## 対象サービス

- Amazon S3
- AWS IAM

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| バージョニング | ソース・レプリカ両方でバージョニング有効 | 25 点 |
| レプリケーションルール | クロスリージョンレプリケーションルール | 30 点 |
| IAM ロール | レプリケーション用 IAM ロール | 25 点 |
| 暗号化 | 両バケットで SSE-S3 暗号化有効 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetBucketVersioning` でソース・レプリカ両方が `Status: Enabled` か
2. `GetBucketReplication` でレプリケーションルールが `Status: Enabled` で正しいレプリカ先が設定されているか
3. `GetBucketReplication` で IAM ロール ARN が設定されているか、`GetRole` でロールが存在するか
4. `GetBucketEncryption` で両バケットに SSE-S3 が設定されているか

## 参考ドキュメント

- [S3 レプリケーション](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- [クロスリージョンレプリケーションの設定](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-walkthrough1.html)
- [レプリケーションに必要な IAM 権限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/setting-repl-config-perm-overview.html)
