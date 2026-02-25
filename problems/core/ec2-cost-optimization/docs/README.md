# EC2 インスタンスのコスト最適化

## 概要

過剰スペックの EC2 環境を再構築し、インスタンスタイプ・EBS・Auto Scaling・タグを最適化する構築型問題です。

## 対象サービス

- Amazon EC2
- Amazon EBS
- Auto Scaling

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| インスタンスタイプ最適化 | t3.medium + Unlimited 無効 | 25 点 |
| EBS ボリューム最適化 | gp3（3000 IOPS, 125 MB/s） | 25 点 |
| Auto Scaling グループ | Min=1, Max=3, Desired=1 | 30 点 |
| Savings Plans タグ | SavingsPlanEligible=true | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeLaunchTemplateVersions` で InstanceType が t3.medium かつ CpuCredits が standard か
2. `DescribeLaunchTemplateVersions` の BlockDeviceMappings で gp3、3000 IOPS、125 MB/s か
3. `DescribeAutoScalingGroups` で MinSize=1, MaxSize=3, DesiredCapacity=1 か
4. `DescribeInstances` のタグに SavingsPlanEligible=true が含まれるか

## 参考ドキュメント

- [EC2 インスタンスタイプ](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-types.html)
- [EBS ボリュームタイプ](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [Auto Scaling グループ](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html)
- [Savings Plans](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
