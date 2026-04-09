# 統合オブザーバビリティプラットフォーム

## 概要

CloudWatch ダッシュボード、複合アラーム、Logs Insights、X-Ray、メトリクスフィルターを組み合わせた統合オブザーバビリティプラットフォームを構築する Expert レベルの構築型問題です。

## 対象サービス

- Amazon CloudWatch (Dashboards, Alarms, Logs, Metrics)
- AWS X-Ray
- AWS Lambda
- Amazon SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ダッシュボード | サービスメトリクス表示 | 15 点 |
| 複合アラーム | 複数アラーム組み合わせ | 25 点 |
| Logs Insights | クエリ定義 | 15 点 |
| X-Ray | Lambda トレーシング | 15 点 |
| メトリクスフィルター | ログからカスタムメトリクス | 20 点 |
| SNS 通知 | 複合アラーム通知 | 10 点 |

## 参考ドキュメント

- [CloudWatch 複合アラーム](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Create_Composite_Alarm.html)
- [Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)
