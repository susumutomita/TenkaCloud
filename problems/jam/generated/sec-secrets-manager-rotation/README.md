# Secrets Manager シークレット管理 + 自動ローテーション

## 概要

Secrets Manager でデータベース認証情報を管理し、KMS 暗号化、自動ローテーション、VPC エンドポイントを設定する構築型問題です。

## 対象サービス

- AWS Secrets Manager
- AWS KMS
- AWS Lambda

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| シークレット + KMS | KMS 暗号化シークレット | 25 点 |
| ローテーション | 30 日自動ローテーション | 25 点 |
| リソースポリシー | 特定ロールのみアクセス | 25 点 |
| VPC エンドポイント | Interface エンドポイント | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeSecret` で KMS 暗号化を確認
2. `DescribeSecret` でローテーション設定を確認
3. `GetResourcePolicy` でリソースポリシーを確認
4. `DescribeVpcEndpoints` で VPC エンドポイントを確認

## 参考ドキュメント

- [Secrets Manager ローテーション](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [Secrets Manager VPC エンドポイント](https://docs.aws.amazon.com/secretsmanager/latest/userguide/vpc-endpoint-overview.html)
