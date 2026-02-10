# GuardDuty と Security Hub による脅威検出・統合管理

## 概要

GuardDuty と Security Hub を有効化し、高重要度の検出結果を自動通知する統合セキュリティ運用基盤を構築する構築型問題です。

## 対象サービス

- Amazon GuardDuty
- AWS Security Hub
- Amazon EventBridge
- AWS Lambda
- Amazon SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| GuardDuty | 検出器の有効化 | 25 点 |
| Security Hub | Hub + CIS ベンチマーク | 25 点 |
| EventBridge ルール | HIGH/CRITICAL フィルタ | 20 点 |
| Lambda 関数 | 検出結果処理 | 15 点 |
| SNS 通知 | セキュリティアラート | 15 点 |

## 参考ドキュメント

- [GuardDuty](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html)
- [Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/what-is-securityhub.html)
