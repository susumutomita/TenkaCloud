# ALB + Auto Scaling グループ構成

## 概要

Application Load Balancer と Auto Scaling グループを組み合わせた、トラフィック変動に自動対応する Web アプリケーション基盤の構築型問題です。

## 対象サービス

- Elastic Load Balancing (ALB)
- EC2 Auto Scaling
- Amazon EC2

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ALB + リスナー設定 | Internet-facing ALB、HTTP リスナー | 25 点 |
| ターゲットグループ + ヘルスチェック | ヘルスチェック設定 | 25 点 |
| Auto Scaling グループ | Launch Template、最小 2/最大 6 | 25 点 |
| スケーリングポリシー | CPU ベース Target Tracking | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeLoadBalancers` で ALB が internet-facing で作成されているか
2. `DescribeListeners` で HTTP リスナーがターゲットグループに転送されているか
3. `DescribeTargetGroups` でヘルスチェックが適切に設定されているか
4. `DescribeAutoScalingGroups` で ASG が最小 2・最大 6 で、ターゲットグループと統合されているか
5. `DescribePolicies` で Target Tracking スケーリングポリシーが設定されているか

## 参考ドキュメント

- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/)
- [Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/)
- [Target Tracking スケーリングポリシー](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html)
