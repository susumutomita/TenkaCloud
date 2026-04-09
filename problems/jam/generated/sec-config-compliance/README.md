# AWS Config コンプライアンス監視

## 概要

AWS Config でセキュリティコンプライアンスを監視し、非準拠リソースの自動修復と通知を設定する構築型問題です。

## 対象サービス

- AWS Config
- AWS Systems Manager Automation
- Amazon EventBridge
- Amazon SNS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Config レコーダー | レコーダー + 配信チャネル | 25 点 |
| マネージドルール | S3/EBS/RDS 暗号化ルール | 25 点 |
| 自動修復 | S3 暗号化の自動適用 | 25 点 |
| 通知 | EventBridge + SNS | 25 点 |

## 参考ドキュメント

- [AWS Config マネージドルール](https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html)
- [Config 自動修復](https://docs.aws.amazon.com/config/latest/developerguide/remediation.html)
