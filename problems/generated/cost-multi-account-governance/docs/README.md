# マルチアカウントコストガバナンスと異常検出

## 概要

AWS Budgets、Cost Anomaly Detection、SNS、Lambda を組み合わせたコストガバナンス基盤を構築する Expert 問題です。

## 対象サービス

- AWS Budgets
- AWS Cost Anomaly Detection
- Amazon SNS
- AWS Lambda

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| AWS Budget | $1000 予算、80％ 実績 + 100％ 予測アラート | 25 点 |
| Cost Anomaly Detection | 異常検出モニター + サブスクリプション | 25 点 |
| SNS トピック | 暗号化付き SNS トピック | 20 点 |
| Lambda 通知 | SNS -> Lambda 通知パイプライン | 15 点 |
| コストタグ | コスト配分タグの標準化 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeBudget` で $1000 月間予算と 80％/100％ アラートが設定されているか
2. `GetAnomalyMonitors` でモニターが存在するか
3. `GetTopicAttributes` で KmsMasterKeyId が設定されているか
4. `ListSubscriptionsByTopic` で Lambda サブスクリプションが存在するか
5. `ListTagsForResource` でコスト配分タグが設定されているか

## 参考ドキュメント

- [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)
- [Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html)
