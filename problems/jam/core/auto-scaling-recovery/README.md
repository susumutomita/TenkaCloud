# Auto Scaling と障害復旧の構築

## 概要

Auto Scaling グループを中心とした自己回復型インフラを構築する構築型問題です。ALB、ヘルスチェック、スケーリングポリシー、SNS 通知を組み合わせた高度な可用性構成を構築します。

## 対象サービス

- Amazon EC2 Auto Scaling
- Elastic Load Balancing (ALB)
- Amazon SNS
- Amazon VPC

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Auto Scaling グループ | 最小 2 台・最大 6 台のマルチ AZ ASG | 25 点 |
| ヘルスチェック | ELB ヘルスチェック + ALB ターゲットグループ | 20 点 |
| スケーリングポリシー | CPU ベースのターゲット追跡ポリシー | 20 点 |
| Application Load Balancer | ALB によるトラフィック分散 | 20 点 |
| SNS 通知 | スケーリングイベントの通知 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeAutoScalingGroups` で MinSize >= 2、MaxSize >= 6、複数 AZ が設定されているか
2. `DescribeAutoScalingGroups` で HealthCheckType が ELB であるか
3. `DescribePolicies` で TargetTrackingScaling ポリシーが ASGAverageCPUUtilization で設定されているか
4. `DescribeLoadBalancers` で ALB が存在し、ターゲットグループが関連付けられているか
5. `DescribeNotificationConfigurations` で SNS 通知が設定されているか

## 参考ドキュメント

- [Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html)
- [ターゲット追跡スケーリングポリシー](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html)
- [Auto Scaling の ELB ヘルスチェック](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-add-elb-healthcheck.html)
- [Auto Scaling の SNS 通知](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-sns-notifications.html)
