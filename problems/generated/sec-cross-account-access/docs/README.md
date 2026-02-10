# クロスアカウント IAM ロール設計

## 概要

クロスアカウントアクセスを ExternalId、IP 制限、セッション制限で安全に設計し、CloudTrail で監査する構築型問題です。

## 対象サービス

- AWS IAM
- AWS STS
- AWS CloudTrail
- Amazon CloudWatch

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| クロスアカウントロール | ExternalId 条件付き | 25 点 |
| 読み取り専用ポリシー | S3 + Logs 読み取りのみ | 20 点 |
| セッション + IP 制限 | 1 時間 + 特定 IP | 20 点 |
| CloudTrail | AssumeRole 監査 | 15 点 |
| CloudWatch Alarm | 異常検知 | 20 点 |

## 参考ドキュメント

- [クロスアカウントアクセス](https://docs.aws.amazon.com/IAM/latest/UserGuide/tutorial_cross-account-with-roles.html)
- [Confused Deputy 問題](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
