# Route 53 ヘルスチェックとフェイルオーバールーティング

## 概要

Route 53 ヘルスチェックとフェイルオーバールーティングポリシーを使い、DNS レベルの自動フェイルオーバーを構築する構築型問題です。

## 対象サービス

- Amazon Route 53
- Amazon CloudWatch
- Amazon SNS

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ヘルスチェック | プライマリエンドポイントの HTTP ヘルスチェック | 30 点 |
| ホストゾーン | Route 53 ホストゾーンの作成 | 20 点 |
| フェイルオーバーレコード | プライマリ/セカンダリのフェイルオーバーレコードセット | 30 点 |
| SNS 通知 | ヘルスチェック状態変化の SNS 通知 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListHealthChecks` で HTTP ヘルスチェックが存在するか
2. `ListHostedZones` でホストゾーンが存在するか
3. `ListResourceRecordSets` でフェイルオーバーレコードが PRIMARY/SECONDARY で構成されているか
4. `ListTopics` で SNS トピックが存在し、CloudWatch アラームと連携しているか

## 参考ドキュメント

- [Route 53 ヘルスチェックの作成](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating.html)
- [フェイルオーバールーティング](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-failover.html)
