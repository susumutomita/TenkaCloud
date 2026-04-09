# GuardDuty 脅威検知 + 自動対応

## 概要

GuardDuty で脅威を検知し、EventBridge + Lambda で自動対応（EC2 隔離）を行う構築型問題です。

## 対象サービス

- Amazon GuardDuty
- Amazon EventBridge
- AWS Lambda
- Amazon SNS
- Amazon S3

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| GuardDuty | ディテクター有効化 | 20 点 |
| EventBridge | High/Critical フィルタ | 20 点 |
| 自動対応 Lambda | EC2 隔離 | 25 点 |
| SNS 通知 | セキュリティチーム通知 | 15 点 |
| S3 アーカイブ | 検出結果保存 | 20 点 |

## 参考ドキュメント

- [GuardDuty](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html)
- [GuardDuty 検出結果の自動対応](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_cloudwatch.html)
