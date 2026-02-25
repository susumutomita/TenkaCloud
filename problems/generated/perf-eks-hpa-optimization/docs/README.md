# EKS HPA/VPA とクラスターオートスケーリング

## 概要

EKS クラスターにマネージドノードグループ、スケーリング設定、ログ、暗号化を構成してパフォーマンスとスケーラビリティを最適化する Expert 問題です。

## 対象サービス

- Amazon EKS
- AWS KMS

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EKS クラスター | Kubernetes 1.29 | 20 点 |
| マネージドノードグループ | t3.large 最小 2 最大 10 希望 3 | 30 点 |
| 更新設定 | maxUnavailable 1 | 15 点 |
| クラスターログ | API + 監査ログ | 15 点 |
| Secrets 暗号化 | KMS 暗号化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeCluster` で Version が 1.29 であるか
2. `DescribeNodegroup` で ScalingConfig が MinSize=2, MaxSize=10, DesiredSize=3 であるか
3. `DescribeNodegroup` で UpdateConfig の MaxUnavailable が 1 であるか
4. `DescribeCluster` の Logging で api と audit が有効であるか
5. `DescribeCluster` の EncryptionConfig で secrets が設定されているか

## 参考ドキュメント

- [EKS マネージドノードグループ](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
- [EKS クラスターログ](https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html)
