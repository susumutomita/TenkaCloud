# カオスエンジニアリング耐障害性テスト基盤

## 概要

AWS FIS を使い、意図的な障害注入によるシステム耐障害性検証基盤を構築する Expert レベルの構築型問題です。

## 対象サービス

- AWS Fault Injection Service (FIS)
- Amazon EC2 Auto Scaling
- Elastic Load Balancing (ALB)
- Amazon CloudWatch
- Amazon SNS
- AWS Systems Manager

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| 対象インフラ | ALB + Auto Scaling グループ | 15 点 |
| FIS 実験テンプレート | EC2 インスタンス停止実験 | 25 点 |
| 停止条件 | CloudWatch アラームベースの停止条件 | 15 点 |
| IAM ロール | FIS 実行用 IAM ロール | 15 点 |
| 監視と通知 | ダッシュボード + SNS 通知 | 15 点 |
| SSM ドキュメント | カスタム障害注入ドキュメント | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeAutoScalingGroups` / `DescribeLoadBalancers` でテスト対象インフラが存在するか
2. `ListExperimentTemplates` で FIS テンプレートが存在し ec2:stop-instances アクションが定義されているか
3. テンプレートの StopConditions に CloudWatch アラームが設定されているか
4. `GetRole` で FIS 用 IAM ロールが存在するか
5. `ListDashboards` でダッシュボードが存在し、`ListTopics` で SNS トピックが存在するか
6. `DescribeDocument` でカスタム SSM ドキュメントが存在するか

## 参考ドキュメント

- [AWS FIS](https://docs.aws.amazon.com/fis/latest/userguide/what-is.html)
- [FIS 実験テンプレート](https://docs.aws.amazon.com/fis/latest/userguide/experiment-templates.html)
