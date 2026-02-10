# CloudTrail と Config ルールによるコンプライアンス構築

## 概要

CloudTrail と AWS Config を構成し、監査証跡とコンプライアンス自動チェックの仕組みを構築する構築型問題です。

## 対象サービス

- AWS CloudTrail
- AWS Config
- AWS Systems Manager (Automation)
- AWS IAM

## コンプライアンス要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CloudTrail 証跡 | マルチリージョン対応の証跡 + S3 ログ保存 | 30 点 |
| Config レコーダー | リソース変更の記録 | 25 点 |
| Config ルール | S3 パブリックアクセスチェック | 25 点 |
| 修復アクション | ルール違反時の自動修復 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeTrails` / `GetTrailStatus` でマルチリージョン証跡が有効で S3 にログが保存される設定か
2. `DescribeConfigurationRecorders` / `DescribeConfigurationRecorderStatus` でレコーダーが有効か
3. `DescribeConfigRules` で S3 パブリックアクセスチェックルールが存在するか
4. `DescribeRemediationConfigurations` で自動修復が構成されているか

## 参考ドキュメント

- [CloudTrail の証跡の作成](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-and-update-a-trail.html)
- [AWS Config の設定](https://docs.aws.amazon.com/config/latest/developerguide/gs-console.html)
- [AWS Config マネージドルール](https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html)
- [AWS Config の修復アクション](https://docs.aws.amazon.com/config/latest/developerguide/remediation.html)
