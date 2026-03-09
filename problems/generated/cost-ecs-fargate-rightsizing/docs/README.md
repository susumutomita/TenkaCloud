# ECS Fargate タスクのリソースライトサイジング

## 概要

ECS Fargate タスクの CPU/メモリを最適化し、FARGATE_SPOT と Auto Scaling でコストを削減する構築型問題です。

## 対象サービス

- Amazon ECS (Fargate)
- Application Auto Scaling

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| タスクサイズ最適化 | CPU 256, メモリ 512 | 30 点 |
| Fargate Spot 活用 | FARGATE_SPOT プロバイダー | 25 点 |
| Auto Scaling ターゲット | CPU 70％ ターゲット追跡 | 25 点 |
| スケーリング範囲 | 最小 1, 最大 4 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeTaskDefinition` で CPU が 256、Memory が 512 であるか
2. `DescribeServices` で CapacityProviderStrategy に FARGATE_SPOT が含まれるか
3. `DescribeScalingPolicies` で CPU 70％ のターゲット追跡ポリシーが存在するか
4. `DescribeScalableTargets` で MinCapacity=1, MaxCapacity=4 であるか

## 参考ドキュメント

- [Fargate タスクサイズ](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [Fargate Spot](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
