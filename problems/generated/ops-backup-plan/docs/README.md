# AWS バックアップ による統合バックアップ計画

## 概要

AWS バックアップを使い、複数リソースの統合バックアップ計画とライフサイクル管理を構築する構築型問題です。

## 対象サービス

- AWS Backup

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| バックアップボールト | 暗号化バックアップボールト | 25 点 |
| バックアップ計画 | 日次バックアップ計画 | 30 点 |
| バックアップルール | 保持 30 日、コールド移行 7 日 | 25 点 |
| リソース割り当て | タグベースリソース選択 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeBackupVault` でボールトが存在するか
2. `GetBackupPlan` でバックアップ計画が存在するか
3. ルールの Lifecycle で MoveToColdStorageAfterDays=7、DeleteAfterDays=30 が設定されているか
4. `ListBackupSelections` でタグベースの選択が存在するか

## 参考ドキュメント

- [AWS Backup](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- [バックアップ計画の作成](https://docs.aws.amazon.com/aws-backup/latest/devguide/creating-a-backup-plan.html)
