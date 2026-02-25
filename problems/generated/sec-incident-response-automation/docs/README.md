# インシデント自動対応基盤

## 概要

GuardDuty/Security Hub の検出結果をトリガーに、Step Functions で EC2 隔離、フォレンジック、IAM 対応を自動化する構築型問題です。

## 対象サービス

- AWS Step Functions
- AWS Lambda
- Amazon EventBridge
- Amazon SNS
- AWS Systems Manager (OpsItem)

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EventBridge | 検出結果トリガー | 15 点 |
| Step Functions | 分岐ワークフロー | 25 点 |
| EC2 隔離 + フォレンジック | SG 変更 + EBS スナップショット | 25 点 |
| IAM 対応 | アクセスキー無効化 | 15 点 |
| 通知 + チケット | SNS + OpsItem | 20 点 |

## 参考ドキュメント

- [GuardDuty 自動対応](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_cloudwatch.html)
- [Step Functions エラーハンドリング](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
