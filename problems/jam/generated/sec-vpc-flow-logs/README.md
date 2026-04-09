# VPC Flow Logs + CloudWatch 分析

## 概要

VPC Flow Logs でネットワークトラフィックを監視し、REJECT トラフィックを CloudWatch で検知・通知する構築型問題です。

## 対象サービス

- Amazon VPC Flow Logs
- Amazon CloudWatch Logs / Metrics / Alarms
- Amazon SNS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Flow Logs | CloudWatch Logs 出力 | 30 点 |
| メトリクスフィルター | REJECT カウント | 25 点 |
| CloudWatch Alarm | 閾値アラーム | 25 点 |
| SNS 通知 | アラーム通知 | 20 点 |

## 参考ドキュメント

- [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html)
- [CloudWatch メトリクスフィルター](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html)
