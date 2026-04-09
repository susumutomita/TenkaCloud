# インシデントレスポンス自動化

## 概要

GuardDuty 検出をトリガーに、Step Functions で証拠保全・封じ込め・通知・記録を自動化するインシデントレスポンス基盤を構築する Expert レベルの構築型問題です。

## 対象サービス

- Amazon EventBridge, Step Functions, Lambda, DynamoDB, SNS
- AWS Systems Manager (Automation)

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EventBridge ルール | GuardDuty HIGH+ トリガー | 15 点 |
| Step Functions | インシデント対応ワークフロー | 25 点 |
| Lambda 関数群 | 証拠保全/隔離/ログ | 20 点 |
| SSM Runbook | Automation ドキュメント | 15 点 |
| SNS 通知 | インシデント通知 | 10 点 |
| DynamoDB | インシデントログテーブル | 15 点 |

## 参考ドキュメント

- [Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [インシデントレスポンスホワイトペーパー](https://docs.aws.amazon.com/whitepapers/latest/aws-security-incident-response-guide/welcome.html)
