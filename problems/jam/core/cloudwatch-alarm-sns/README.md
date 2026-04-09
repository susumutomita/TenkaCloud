# CloudWatch アラームと SNS 通知の構築

## 概要

CloudWatch アラームと SNS 通知を構成し、本番環境のモニタリング基盤を構築する構築型問題です。

## 対象サービス

- Amazon CloudWatch
- Amazon SNS
- Amazon EC2

## モニタリング要件

| 要件 | 内容 | 配点 |
|------|------|------|
| SNS トピック | アラート通知用 SNS トピック + メールサブスクリプション | 25 点 |
| CPU アラーム | CPU 使用率 80％ 超過のアラーム | 30 点 |
| ステータスチェックアラーム | ステータスチェック失敗のアラーム | 20 点 |
| ダッシュボード | 主要メトリクスの CloudWatch ダッシュボード | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListTopics` / `ListSubscriptionsByTopic` で SNS トピックとメールサブスクリプションが存在するか
2. `DescribeAlarms` で CPUUtilization メトリクスのアラームが閾値 80 で設定され、AlarmActions に SNS トピックが指定されているか
3. `DescribeAlarms` で StatusCheckFailed メトリクスのアラームが設定されているか
4. `ListDashboards` / `GetDashboard` でダッシュボードが作成されているか

## 参考ドキュメント

- [CloudWatch アラームの作成](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [CloudWatch ダッシュボード](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [SNS 通知の設定](https://docs.aws.amazon.com/sns/latest/dg/sns-create-topic.html)
