# マルチリージョン DNS フェイルオーバーとヘルスチェック連携

## 概要

Route 53 と CloudWatch を組み合わせた複合ヘルスチェックとマルチリージョン DNS フェイルオーバーを構築する構築型問題です。

## 対象サービス

- Amazon Route 53
- Amazon CloudWatch
- Amazon SNS

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| 個別ヘルスチェック | 各リージョンの HTTP ヘルスチェック | 20 点 |
| 計算済みヘルスチェック | 複数ヘルスチェックの複合判定 | 25 点 |
| フェイルオーバーレコード | Route 53 フェイルオーバールーティング | 25 点 |
| CloudWatch アラーム | ヘルスチェック状態監視 | 15 点 |
| SNS 通知 | フェイルオーバー発生時通知 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListHealthChecks` で HTTP ヘルスチェックが 2 つ存在するか
2. `ListHealthChecks` で CALCULATED タイプのヘルスチェックが存在するか
3. `ListResourceRecordSets` で PRIMARY/SECONDARY フェイルオーバーレコードが存在するか
4. `DescribeAlarms` でヘルスチェックの CloudWatch アラームが存在するか
5. `ListTopics` で SNS トピックが存在しアラームと連携しているか

## 参考ドキュメント

- [Route 53 計算済みヘルスチェック](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html)
- [Route 53 フェイルオーバー](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-failover.html)
