# EFS マルチ AZ 高可用性ファイルストレージ

## 概要

EFS ファイルシステムをマルチ AZ 構成で構築し、暗号化・ライフサイクル・バックアップを備えた高可用性共有ストレージを実現する構築型問題です。

## 対象サービス

- Amazon EFS
- Amazon VPC
- AWS Backup

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ファイルシステム | 暗号化された EFS ファイルシステム | 25 点 |
| マウントターゲット | 2 つ以上の AZ にマウントターゲット | 30 点 |
| ライフサイクルポリシー | 30 日未アクセスファイルの IA 自動移行 | 20 点 |
| バックアップ | AWS バックアップ 自動バックアップ | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeFileSystems` で暗号化された EFS が存在するか
2. `DescribeMountTargets` で 2 つ以上の AZ にマウントターゲットが存在するか
3. `DescribeLifecycleConfiguration` で TransitionToIA が AFTER_30_DAYS に設定されているか
4. `DescribeBackupPolicy` で Status が ENABLED であるか

## 参考ドキュメント

- [EFS ファイルシステム](https://docs.aws.amazon.com/efs/latest/ug/creating-using-fs.html)
- [EFS ライフサイクル管理](https://docs.aws.amazon.com/efs/latest/ug/lifecycle-management-efs.html)
