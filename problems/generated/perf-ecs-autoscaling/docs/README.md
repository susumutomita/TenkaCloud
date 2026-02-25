# ECS サービスオートスケーリングとヘルスチェック最適化

## 概要

ECS サービスにターゲット追跡スケーリングと ALB ヘルスチェックの最適化を構成する構築型問題です。

## 対象サービス

- Amazon ECS (Fargate)
- Elastic Load Balancing (ALB)
- Application Auto Scaling

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ターゲット追跡スケーリング | ALBRequestCountPerTarget 100 | 30 点 |
| スケーリング範囲 | 最小 2、最大 10 | 20 点 |
| ヘルスチェック最適化 | 間隔 10 秒、しきい値 2 | 25 点 |
| デプロイ設定 | 最小 100％、最大 200% | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeScalingPolicies` で ALBRequestCountPerTarget ターゲット 100 であるか
2. `DescribeScalableTargets` で MinCapacity=2, MaxCapacity=10 であるか
3. `DescribeTargetGroups` で HealthCheckIntervalSeconds=10, HealthyThresholdCount=2 であるか
4. `DescribeServices` で MinimumHealthyPercent=100, MaximumPercent=200 であるか

## 参考ドキュメント

- [ECS サービス Auto Scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html)
- [ALB ヘルスチェック](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
