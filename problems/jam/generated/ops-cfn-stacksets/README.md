# CloudFormation StackSets マルチアカウントデプロイ

## 概要

CloudFormation StackSets を使い、マルチアカウントへのセキュリティベースライン一括デプロイ基盤を構築する構築型問題です。

## 対象サービス

- AWS CloudFormation (StackSets)
- AWS IAM

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| StackSet | セキュリティベースライン StackSet | 25 点 |
| 管理者ロール | StackSets 管理者 IAM ロール | 20 点 |
| 実行ロール | ターゲットアカウント実行 IAM ロール | 20 点 |
| テンプレート | CloudTrail + Config テンプレート | 20 点 |
| デプロイ設定 | 同時実行数・失敗許容数 | 15 点 |

## 参考ドキュメント

- [CloudFormation StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html)
