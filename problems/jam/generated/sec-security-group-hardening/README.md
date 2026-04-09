# セキュリティグループ強化設計

## 概要

Web/App/DB の 3 層セキュリティグループを最小権限の原則に基づいて設計する構築型問題です。

## 対象サービス

- Amazon VPC Security Groups

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Web 層 SG | HTTP/HTTPS イン + App アウト | 25 点 |
| App 層 SG | Web イン + DB アウト | 25 点 |
| DB 層 SG | App イン + アウトなし | 25 点 |
| Description | 全ルールに設定 | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeSecurityGroups` で各層の SG ルールを確認
2. インバウンド/アウトバウンドの制限が正しいか確認
3. DB 層にアウトバウンドルールがないことを確認
4. 全ルールに Description が設定されていることを確認

## 参考ドキュメント

- [セキュリティグループのベストプラクティス](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html)
