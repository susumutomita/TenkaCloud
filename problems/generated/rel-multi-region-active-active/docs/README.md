# マルチリージョンアクティブ-アクティブ構成

## 概要

Global Accelerator、ALB、DynamoDB Global Tables、SQS + Lambda を組み合わせたマルチリージョンアクティブ-アクティブ構成を構築する Expert レベルの構築型問題です。

## 対象サービス

- AWS Global Accelerator
- Elastic Load Balancing (ALB)
- Amazon DynamoDB (Global Tables)
- Amazon SQS
- AWS Lambda
- Amazon Route 53
- Amazon CloudWatch
- Amazon SNS

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Global Accelerator | グローバルエントリポイント | 15 点 |
| マルチリージョン ALB | 2 リージョンの ALB + トラフィック分散 | 20 点 |
| DynamoDB Global Tables | データ双方向同期 | 20 点 |
| SQS + Lambda | 各リージョンの非同期処理パイプライン | 20 点 |
| ヘルスチェックと監視 | Route 53 HC + CloudWatch アラーム | 15 点 |
| SNS 通知 | クロスリージョン障害通知 | 10 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListAccelerators` / `ListEndpointGroups` で Global Accelerator が構成されているか
2. `DescribeLoadBalancers` で ALB が存在するか
3. `DescribeGlobalTable` でグローバルテーブルが構成されているか
4. `ListEventSourceMappings` / `GetQueueAttributes` で SQS + Lambda パイプラインが構成されているか
5. `ListHealthChecks` / `DescribeAlarms` でヘルスチェックとアラームが設定されているか
6. `ListTopics` で SNS トピックが存在するか

## 参考ドキュメント

- [マルチリージョンアーキテクチャ](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [Global Accelerator](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [DynamoDB Global Tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
